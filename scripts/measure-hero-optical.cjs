/**
 * hero 光学对齐的像素级测量。
 *
 * 背景：DOM 几何显示 logo 与「标题行盒 + 副标题行盒」完全等高（Δ0.00px），
 * 但视觉复核觉得"徽标比文字高约 20%"。两种说法要能同时成立，只可能是
 * **行盒 ≠ 墨迹**：副标题的行盒 18px 里，字形只占约 13px，
 * 徽标贴的是行盒下缘，于是看起来比"文字的实际下缘"低一截。
 *
 * 本脚本直接读截图像素，分别求出：
 *   · 红色徽标的墨迹包围盒（R>150 且明显偏红）
 *   · 文字的墨迹包围盒（亮且非红）
 * 然后给出四个方向的差值，判断光学对齐是否需要补偿。
 *
 * 用法：node scripts/measure-hero-optical.cjs [dark|light]
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const THEME = process.argv[2] || 'dark'
const SCALE = 3 // 高清截图，1px 误差在缩放后仍可分辨

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: THEME === 'dark' ? '#15171c' : '#f4f5f7',
  })
  const file = path.join(process.cwd(), 'dist', 'index.html').split(path.sep).join('/')
  await win.loadURL('file:///' + file.replace(/^\//, ''))
  await new Promise((r) => setTimeout(r, 2500))
  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-theme','${THEME}');` +
      `document.documentElement.style.colorScheme='${THEME}';`,
  )
  // 强制重绘（否则截图是旧帧）
  await win.webContents.executeJavaScript(
    'new Promise(function(res){requestAnimationFrame(function(){requestAnimationFrame(function(){res(1)})})})',
  )
  win.setSize(1441, 901)
  await new Promise((r) => setTimeout(r, 300))
  win.setSize(1440, 900)
  await new Promise((r) => setTimeout(r, 1200))

  const geo = JSON.parse(
    await win.webContents.executeJavaScript(`
    (function(){
      var hero = document.querySelector('.s-welcome-panel .hero')
      var logo = hero.querySelector('.logo')
      var title = hero.querySelector('.welcome-title')
      var sub = hero.querySelector('.subtitle')
      function b(el){ var r = el.getBoundingClientRect(); return { t:r.top, b:r.bottom, l:r.left, r:r.right } }
      var hr = b(hero)
      return JSON.stringify({
        hero: hr,
        logo: b(logo),
        title: b(title),
        subtitle: b(sub),
        dpr: window.devicePixelRatio
      })
    })()
  `),
  )

  // 用 CDP 截 hero 区域的高清图
  const dbg = win.webContents.debugger
  try {
    dbg.attach('1.3')
  } catch {
    /* attached */
  }
  const clip = {
    x: Math.floor(geo.hero.l),
    y: Math.floor(geo.hero.t),
    width: Math.ceil(geo.hero.r - geo.hero.l),
    height: Math.ceil(geo.hero.b - geo.hero.t),
    scale: SCALE,
  }
  const { data } = await dbg.sendCommand('Page.captureScreenshot', {
    format: 'png',
    clip,
  })
  const png = Buffer.from(data, 'base64')
  fs.writeFileSync(`hero-optical-${THEME}.png`, png)

  const img = nativeImage.createFromBuffer(png)
  const sz = img.getSize()
  const bmp = img.toBitmap()
  const W = sz.width
  const H = sz.height
  const at = (x, y) => {
    const o = (y * W + x) * 4
    return [bmp[o + 2], bmp[o + 1], bmp[o]] // RGB
  }

  /* 按 DOM 几何切分左右两列（标题的渐变里也有大量红色像素，
     靠颜色区分必然把标题误判成徽标 —— 用 x 分界才可靠）*/
  const badgeRightPx = Math.round((geo.logo.r - geo.hero.l) * SCALE) + 6

  let badge = { minX: 1e9, minY: 1e9, maxX: -1, maxY: -1, n: 0 } // 仅左列
  let text = { minX: 1e9, minY: 1e9, maxX: -1, maxY: -1, n: 0 }

  const isDark = THEME === 'dark'
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = at(x, y)
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
      // 红色徽标：红通道显著高于绿蓝
      const isRed = r > 120 && r - g > 50 && r - b > 50
      if (x < badgeRightPx && isRed) {
        badge.n++
        if (x < badge.minX) badge.minX = x
        if (x > badge.maxX) badge.maxX = x
        if (y < badge.minY) badge.minY = y
        if (y > badge.maxY) badge.maxY = y
        continue
      }
      // 文字：与背景有反差（暗底找亮像素 / 亮底找暗像素）
      const isText = isDark ? lum > 90 : lum < 200
      if (isText) {
        text.n++
        if (x < text.minX) text.minX = x
        if (x > text.maxX) text.maxX = x
        if (y < text.minY) text.minY = y
        if (y > text.maxY) text.maxY = y
      }
    }
  }

  /* 文字包围盒里可能混入徽标旁的抗锯齿边缘，按 x 过滤掉左列区域 */
  const badgeW = badge.maxX - badge.minX + 1
  /* 右列起点取标题的 DOM 左缘（少 2px 容差），而不是徽标的墨迹右缘 */
  const textLeftPx = Math.max(0, Math.round((geo.title.l - geo.hero.l) * SCALE) - 2)
  let textOnly = { minY: 1e9, maxY: -1, n: 0 }
  for (let y = 0; y < H; y++) {
    for (let x = textLeftPx; x < W; x++) {
      const [r, g, b] = at(x, y)
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const isRed = r > 120 && r - g > 50 && r - b > 50
      if (isRed) continue
      const isText = isDark ? lum > 90 : lum < 200
      if (!isText) continue
      textOnly.n++
      if (y < textOnly.minY) textOnly.minY = y
      if (y > textOnly.maxY) textOnly.maxY = y
    }
  }

  /* 诊断：右列在副标题 y 区间内的亮度最小值 */
  if (!isDark) {
    let minLum = 999, minY = -1
    const y0 = Math.round((geo.subtitle.t - geo.hero.t) * SCALE)
    const y1 = Math.round((geo.subtitle.b - geo.hero.t) * SCALE)
    for (let y = y0; y < Math.min(y1 + 1, H); y++) {
      for (let x = textLeftPx; x < W; x++) {
        const [r,g,b] = at(x,y)
        const L = 0.2126*r + 0.7152*g + 0.0722*b
        if (L < minLum) { minLum = L; minY = y }
      }
    }
    console.log('副标题区最暗像素亮度:', minLum.toFixed(1), '@y', minY, '(区间', y0, '-', y1, ')')
  }

  const s = SCALE
  console.log(`=== 像素实测 (${THEME}, scale=${s}) ===`)
  console.log(`  截图尺寸        : ${W} × ${H}`)
  console.log(`  徽标墨迹        : y ${badge.minY} → ${badge.maxY}  (高 ${badge.maxY - badge.minY + 1}px @${s}x  = ${((badge.maxY - badge.minY + 1) / s).toFixed(2)} CSS px)`)
  console.log(`  文字墨迹(右列)  : y ${textOnly.minY} → ${textOnly.maxY}  (高 ${textOnly.maxY - textOnly.minY + 1}px @${s}x  = ${((textOnly.maxY - textOnly.minY + 1) / s).toFixed(2)} CSS px)`)
  console.log(`  徽标宽          : ${badgeW}px @${s}x = ${(badgeW / s).toFixed(2)} CSS px`)
  console.log('')
  console.log(`  顶部差 (徽标顶 - 文字顶) : ${((badge.minY - textOnly.minY) / s).toFixed(2)} CSS px`)
  console.log(`  底部差 (徽标底 - 文字底) : ${((badge.maxY - textOnly.maxY) / s).toFixed(2)} CSS px`)
  console.log('')
  console.log('=== DOM 几何（对照）===')
  console.log(`  logo   : ${geo.logo.t.toFixed(2)} → ${geo.logo.b.toFixed(2)}`)
  console.log(`  title  : ${geo.title.t.toFixed(2)} → ${geo.title.b.toFixed(2)}`)
  console.log(`  sub    : ${geo.subtitle.t.toFixed(2)} → ${geo.subtitle.b.toFixed(2)}`)

  app.exit(0)
})

setTimeout(() => {
  console.log('TIMEOUT')
  app.exit(1)
}, 50000)
