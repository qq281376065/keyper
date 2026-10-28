/**
 * hero 与顶栏的对齐 / 留白测量。
 *
 * 用途：确认三件事的实测值
 *   1. 顶栏品牌图标（.topbar .brand .logo）与 hero 图标（.hero .logo）的
 *      尺寸差、左缘差、上缘差 —— 判断"没对齐"具体差在哪
 *   2. welcome 区顶部留白（.workspace-body → .hero 的间距）实际多少
 *   3. 标题是否 autoPlay
 *
 * 用法：node scripts/measure-hero-align.cjs [dark|light] [port]
 */
const path = require('node:path')

const THEME = process.argv[2] || 'dark'
const PORT = process.argv[3] ? Number(process.argv[3]) : null

const PROBE = `
  (function(){
    function b(el){ if(!el) return null; var r = el.getBoundingClientRect(); return {
      t:+r.top.toFixed(2), b:+r.bottom.toFixed(2), l:+r.left.toFixed(2),
      r:+r.right.toFixed(2), w:+r.width.toFixed(2), h:+r.height.toFixed(2)
    } }
    var topLogo = document.querySelector('.topbar .brand .logo')
    var topBrand = document.querySelector('.topbar .brand')
    var hero = document.querySelector('.s-welcome-panel .hero')
    var heroLogo = document.querySelector('.s-welcome-panel .hero .logo')
    var welcome = document.querySelector('.s-welcome-panel')
    var inner = document.querySelector('.s-welcome-panel .inner')
    var body = document.querySelector('.workspace-body')
    var title = document.querySelector('.welcome-title')
    var title = document.querySelector('.welcome-title')
    var cs = inner ? getComputedStyle(inner) : null
    var wcs = welcome ? getComputedStyle(welcome) : null
    return JSON.stringify({
      topbar: b(topBrand), topLogo: b(topLogo),
      hero: b(hero), heroLogo: b(heroLogo),
      welcome: b(welcome), inner: b(inner), body: b(body),
      innerPad: cs ? cs.padding : null,
      welcomePad: wcs ? wcs.padding : null,
      welcomeOverflow: wcs ? wcs.overflowY : null,
      titleBox: b(title),
      titleAutoPlay: title ? title.dataset.state : null,
      titleMode: title ? title.dataset.mode : null
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
      const win = new BrowserWindow({ width: 1440, height: 900, show: false })
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
    console.log('读取失败')
    process.exit(1)
  }
  const g = JSON.parse(raw)
  const f = (n) => (n === null || n === undefined ? '—' : n.toFixed(2).padStart(8))

  console.log('=== 顶栏 ===')
  console.log('  .brand    l/t/h :', f(g.topbar?.l), f(g.topbar?.t), f(g.topbar?.h))
  console.log('  顶栏 logo l/t/w/h:', f(g.topLogo?.l), f(g.topLogo?.t), f(g.topLogo?.w), f(g.topLogo?.h))
  console.log('=== hero ===')
  console.log('  .hero     l/t/h :', f(g.hero?.l), f(g.hero?.t), f(g.hero?.h))
  console.log('  hero logo l/t/w/h:', f(g.heroLogo?.l), f(g.heroLogo?.t), f(g.heroLogo?.w), f(g.heroLogo?.h))
  console.log('=== 容器 ===')
  console.log('  .body     l/t    :', f(g.body?.l), f(g.body?.t))
  console.log('  .welcome  l/t/pad:', f(g.welcome?.l), f(g.welcome?.t), g.welcomePad)
  console.log('  .inner    l/t/pad:', f(g.inner?.l), f(g.inner?.t), g.innerPad)
  console.log('=== 差值 ===')
  console.log('  顶栏 logo 底 → hero 顶  :', f((g.hero?.t ?? 0) - (g.topLogo?.b ?? 0)), 'px（顶部留白）')
  console.log('  hero logo 左 - 顶栏 logo 左:', f((g.heroLogo?.l ?? 0) - (g.topLogo?.l ?? 0)), 'px')
  console.log('  hero logo 左 - 内容区左   :', f((g.heroLogo?.l ?? 0) - (g.inner?.l ?? 0)), 'px')
  console.log('  尺寸比 hero/顶栏         :', ((g.heroLogo?.w ?? 0) / (g.topLogo?.w ?? 1)).toFixed(2) + '×')
  console.log('=== 顶边对齐（图标顶 vs 大标题顶）===')
  console.log('  hero logo 顶    :', f(g.heroLogo?.t))
  console.log('  大标题行盒顶    :', f(g.titleBox?.t))
  console.log('  差值            :', f((g.heroLogo?.t ?? 0) - (g.titleBox?.t ?? 0)), 'px （0 = 齐平）')
  console.log('  图标高 / 大标题高:', f(g.heroLogo?.h), '/', f(g.titleBox?.h))
  console.log('=== 标题 ===')
  console.log('  mode:', g.titleMode, '| data-state:', g.titleAutoPlay, '(active = 正在播放)')

  process.exit(0)
}

main().catch((e) => {
  console.log('ERROR', e.message)
  process.exit(1)
})
