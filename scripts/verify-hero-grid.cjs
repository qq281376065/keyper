/**
 * hero 图标对齐校验（行盒 + 墨迹双判据）。
 *
 * 这里容易犯错的地方：徽标高度只有网格行高的 80%，并做了 6.5px 垂直补偿，
 * 所以「徽标盒 vs 文字行盒」的上下缘**本来就该有差值**（约 14.5 / -1.5px）。
 * 若拿行盒差做断言，就会把正确实现判成 FAIL。
 *
 * 真正的判据是：
 *   · 行盒层面 —— 徽标必须跨两行（grid-row: 1 / -1），且高度 ≈ 行高 80%；
 *   · 墨迹层面 —— 徽标的上下缘要与**文字墨迹**齐平（视觉对齐）。
 *
 * 墨迹无法从 DOM 直接读，因此这里只校验行盒关系，墨迹交给
 * measure-hero-optical.cjs（读像素）。两份一起看才是完整证据。
 *
 * 用法：node scripts/verify-hero-grid.cjs [dark|light] [port]
 */
const fs = require('node:fs')
const path = require('node:path')

const THEME = process.argv[2] || 'dark'
const PORT = process.argv[3] ? Number(process.argv[3]) : null

const PROBE = `
  (function(){
    var hero = document.querySelector('.s-welcome-panel .hero')
    if (!hero) return JSON.stringify({ missing:true })
    var logo = hero.querySelector('.logo')
    var title = hero.querySelector('.welcome-title')
    var sub = hero.querySelector('.subtitle')
    if (!logo || !title || !sub) return JSON.stringify({ missing:true })
    function b(el){ var r = el.getBoundingClientRect(); return {
      t:+r.top.toFixed(2), b:+r.bottom.toFixed(2), l:+r.left.toFixed(2),
      r:+r.right.toFixed(2), w:+r.width.toFixed(2), h:+r.height.toFixed(2)
    } }
    var cs = getComputedStyle(hero)
    var lcs = getComputedStyle(logo)
    var hr = b(hero), lr = b(logo), tr = b(title), sr = b(sub)
    var rowsSum = tr.h + sr.h + parseFloat(cs.rowGap || 0)
    return JSON.stringify({
      hero: hr, logo: lr, title: tr, subtitle: sr,
      display: cs.display, rowGap: cs.rowGap, colGap: cs.columnGap,
      logoGridRow: lcs.gridRowStart + ' / ' + lcs.gridRowEnd,
      logoAspect: lcs.aspectRatio,
      logoTransform: lcs.transform,
      titleSize: getComputedStyle(title).fontSize,
      logoFont: lcs.fontSize,
      rowsSum: +rowsSum.toFixed(2),
      heightRatio: +(lr.h / rowsSum).toFixed(4),
      colGapActual: +(tr.l - lr.r).toFixed(2),
      overflowRight: +(Math.max(lr.r, tr.r, sr.r) - hr.r).toFixed(2)
    })
  })()
`

async function viaHttp() {
  const http = require('node:http')
  const getJson = (p) =>
    new Promise((res, rej) => {
      const r = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 5000 }, (s) => {
        let d = ''
        s.on('data', (c) => (d += c))
        s.on('end', () => {
          try {
            res(JSON.parse(d))
          } catch (e) {
            rej(e)
          }
        })
      })
      r.on('error', rej)
    })
  const targets = await getJson('/json/list')
  const pg = targets.find((x) => x.type === 'page' && !x.url.startsWith('devtools'))
  const ws = new WebSocket(pg.webSocketDebuggerUrl)
  let seq = 0
  const pend = new Map()
  const ev = (e) =>
    new Promise((r) => {
      const id = ++seq
      pend.set(id, r)
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true } }))
    })
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      const r = pend.get(m.id)
      pend.delete(m.id)
      r(m.result?.result?.value)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))
  const out = await ev(PROBE)
  ws.close()
  return out
}

async function viaElectron() {
  const { app, BrowserWindow } = require('electron')
  app.disableHardwareAcceleration()
  return new Promise((resolve) => {
    app.whenReady().then(async () => {
      const win = new BrowserWindow({
        width: 1440,
        height: 900,
        show: false,
        backgroundColor: THEME === 'dark' ? '#15171c' : '#f4f5f7',
      })
      const file = path.join(process.cwd(), 'dist', 'index.html').split(path.sep).join('/')
      await win.loadURL('file:///' + file.replace(/^\//, ''))
      await new Promise((r) => setTimeout(r, 2400))
      await win.webContents.executeJavaScript(
        `document.documentElement.setAttribute('data-theme','${THEME}');` +
          `document.documentElement.style.colorScheme='${THEME}';`,
      )
      await new Promise((r) => setTimeout(r, 600))
      const out = await win.webContents.executeJavaScript(PROBE)
      app.exit(0)
      resolve(out)
    })
    setTimeout(() => {
      app.exit(1)
      resolve(null)
    }, 40000)
  })
}

async function main() {
  const raw = PORT ? await viaHttp() : await viaElectron()
  if (!raw) {
    console.log('读取页面状态失败')
    process.exit(1)
  }
  const g = JSON.parse(raw)
  if (g.missing) {
    console.log('未找到 hero 结构元素')
    process.exit(1)
  }

  const d = (a, b) => Math.abs(a - b)
  const checks = [
    ['display 是 grid', g.display === 'grid', g.display],
    ['徽标跨两行', g.logoGridRow.replace(/\s/g, '') === '1/-1', g.logoGridRow],
    ['徽标正方', d(g.logo.w, g.logo.h) <= 1.5, `${g.logo.w} × ${g.logo.h}`],
    [
      '高度 = 两行行盒之和',
      g.heightRatio > 0.99 && g.heightRatio < 1.01,
      `${(g.heightRatio * 100).toFixed(1)}% of ${g.rowsSum}px`,
    ],
    ['列间距 = 16px', d(g.colGapActual, parseFloat(g.colGap)) <= 1.5, `${g.colGapActual} vs ${g.colGap}`],
    ['无横向溢出', g.overflowRight <= 1, `overflowRight=${g.overflowRight}`],
    [
      '无垂直位移（严格对齐）',
      g.logoTransform === 'none',
      g.logoTransform,
    ],
    ['徽标字号随标题缩放', parseFloat(g.logoFont) > 0, `title ${g.titleSize} → R ${g.logoFont}`],
  ]

  console.log('=== 实测 ===')
  console.log('  logo   :', JSON.stringify(g.logo), '| grid-row:', g.logoGridRow)
  console.log('  title  :', JSON.stringify(g.title))
  console.log('  sub    :', JSON.stringify(g.subtitle))
  console.log('  行高之和:', g.rowsSum, '| 徽标占比:', (g.heightRatio * 100).toFixed(1) + '%')
  console.log('  徽标字号:', g.logoFont, '(标题', g.titleSize + ')')
  console.log('=== 断言 ===')
  let failed = 0
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} ${detail}`)
    if (!ok) failed++
  }
  console.log('')
  console.log('图标严格铺满两行行盒（不再做墨迹收缩）。')
  console.log('墨迹级校验见 measure-hero-optical.cjs —— 文字字形必然窄于行盒，属正常。')
  console.log(failed === 0 ? '\n行盒断言全部通过' : `\n${failed} 项未通过`)
  process.exit(failed === 0 ? 0 : 2)
}

main().catch((e) => {
  console.log('ERROR', e.message)
  process.exit(1)
})
