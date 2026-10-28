/**
 * hero 网格的多尺寸健壮性验证。
 *
 * 标题字号是 clamp(36px, 4vw, 56px)，徽标高度用 80% 跟随网格行高 ——
 * 两者都必须随窗口缩放而保持"图标撑满两行"的关系。
 * 本脚本在 5 个宽度下重复断言，抓"只在某个宽度下崩"的问题
 * （例如窄窗口下标题换行 → 行数变 3 → 徽标高度算错）。
 *
 * 用法：node scripts/verify-hero-responsive.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const SIZES = [
  [1024, 760],
  [1280, 820],
  [1440, 900],
  [1680, 960],
  [1920, 1040],
]

app.disableHardwareAcceleration()

const PROBE = `
  (function(){
    var hero = document.querySelector('.s-welcome-panel .hero')
    if (!hero) return JSON.stringify({ missing:true })
    var logo = hero.querySelector('.logo')
    var title = hero.querySelector('.welcome-title')
    var sub = hero.querySelector('.subtitle')
    if (!logo || !title || !sub) return JSON.stringify({ missing:true })
    function b(el){ var r = el.getBoundingClientRect(); return {
      t:r.top, b:r.bottom, l:r.left, r:r.right, w:r.width, h:r.height
    } }
    var hr = b(hero), lr = b(logo), tr = b(title), sr = b(sub)
    return JSON.stringify({
      hero: hr, logo: lr, title: tr, subtitle: sr,
      titleLines: Math.round(tr.h / parseFloat(getComputedStyle(title).lineHeight)),
      titleFont: getComputedStyle(title).fontSize,
      logoFont: getComputedStyle(logo).fontSize,
      gap: tr.l - lr.r,
      overflowX: +(Math.max(lr.r, tr.r, sr.r) - hr.r).toFixed(2),
      overflowLeft: +(hr.l - Math.min(lr.l, tr.l, sr.l)).toFixed(2)
    })
  })()
`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false })
  const file = path.join(process.cwd(), 'dist', 'index.html').split(path.sep).join('/')
  await win.loadURL('file:///' + file.replace(/^\//, ''))
  await new Promise((r) => setTimeout(r, 2400))

  let failed = 0
  console.log('宽度  | 标题字号 | 徽标字号 | 标题行数 | 徽标/两行行盒 | 列间距 | 溢出')
  console.log(''.padEnd(96, '-'))

  for (const [w, h] of SIZES) {
    win.setSize(w, h)
    await new Promise((r) => setTimeout(r, 700))
    const g = JSON.parse(await win.webContents.executeJavaScript(PROBE))
    if (g.missing) {
      console.log(`${w}  | 未找到 hero`)
      failed++
      continue
    }
    /* 徽标应严格等于「标题行盒 + 行距 + 副标题行盒」*/
    const rowsSum = g.title.h + g.subtitle.h + 4
    const ratio = g.logo.h / rowsSum
    /* 设计已改为"图标严格铺满两行"，占比应为 100%（不再留光学收缩）*/
    const okRatio = ratio > 0.99 && ratio < 1.01
    const okOverflow = g.overflowX <= 1 && g.overflowLeft <= 1
    const okGap = g.gap >= 14 && g.gap <= 18
    const okSingleLine = g.titleLines === 1
    const ok = okRatio && okOverflow && okGap && okSingleLine
    if (!ok) failed++
    console.log(
      `${w}  | ${g.titleFont.padStart(8)} | ${g.logoFont.padStart(8)} | ${String(g.titleLines).padStart(8)} | ` +
        `${(g.logo.h / rowsSum * 100).toFixed(1)}% ${okRatio ? ' ' : '!'}          | ${g.gap.toFixed(1).padStart(6)} | ` +
        `${g.overflowX.toFixed(1)}${okOverflow ? '' : ' !'}${okSingleLine ? '' : ' 换行!'}`,
    )
  }

  console.log('')
  console.log(failed === 0 ? '全部尺寸通过' : `${failed} 个尺寸未通过`)
  app.exit(failed === 0 ? 0 : 2)
})

setTimeout(() => {
  console.log('TIMEOUT')
  app.exit(1)
}, 60000)
