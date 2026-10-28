/**
 * 主题背景核实：深色主题下 welcome 区到底是不是深底。
 *
 * 起因：hero 截图的视觉复核报告"深色主题下背景仍近白"，与实测
 * body bg = rgb(21,23,28) 矛盾。必须用像素采样定位到底是
 *   (a) 视觉代理误判，还是
 *   (b) .welcome / .inner / .card 有浅色底把深色画布盖住了（真缺陷）
 *
 * 做法：截整页 → 直接读 PNG 像素，输出若干关键点的实际 RGB，
 * 并同时打印这些点所在元素的 computed background，两者互证。
 *
 * 用法：node scripts/verify-hero-theme.cjs [dark|light]
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const THEME = process.argv[2] || 'dark'

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: THEME === 'dark' ? '#15171c' : '#f4f5f7',
  })
  const file = path.join(process.cwd(), 'dist', 'index.html').replace(/\\/g, '/')
  await win.loadURL(`file://${file}`)
  await new Promise((r) => setTimeout(r, 2500))
  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-theme', '${THEME}');` +
      `document.documentElement.style.colorScheme = '${THEME}';`,
  )
  /* 强制一次真实重绘：capturePage 会返回上一次合成的帧，
     仅改 CSS 变量不会立刻产生新的合成表面 → 截到旧主题。
     连续等两帧 rAF + 轻微 resize 抖动，确保合成器提交新帧。 */
  await win.webContents.executeJavaScript()
  win.setSize(1441, 901)
  await new Promise((r) => setTimeout(r, 400))
  win.setSize(1440, 900)
  await new Promise((r) => setTimeout(r, 1400))

  /* 关键元素的 computed background（含层级链） */
  const chain = JSON.parse(
    await win.webContents.executeJavaScript(`
    (function(){
      var sels = [
        ['html', 'html'],
        ['body', 'body'],
        ['.shell', '.shell'],
        ['.workspace-body', '.workspace-body'],
        ['.welcome', '.s-welcome-panel'],
        ['.inner', '.s-welcome-panel .inner'],
        ['.hero', '.s-welcome-panel .hero'],
        ['.hero-text', '.s-welcome-panel .hero-text']
      ]
      var out = []
      sels.forEach(function(pair){
        var el = document.querySelector(pair[1])
        if (!el) { out.push({ name: pair[0], missing: true }); return }
        var cs = getComputedStyle(el)
        out.push({
          name: pair[0],
          bg: cs.backgroundColor,
          bgImage: cs.backgroundImage === 'none' ? null : cs.backgroundImage.slice(0, 50),
          color: cs.color
        })
      })
      return JSON.stringify(out)
    })()
  `),
  )

  console.log('=== computed background 链 ===')
  for (const c of chain) {
    console.log(
      '  ' + String(c.name).padEnd(16),
      c.missing ? '(未找到)' : `bg=${c.bg}  img=${c.bgImage || 'none'}`,
    )
  }

  /* 截图并按点采样像素 */
  const img = await win.webContents.capturePage()
  const png = img.toPNG()
  const { width, height } = img.getSize()
  fs.writeFileSync(`hero-theme-${THEME}.png`, png)

  const bmp = nativeImage.createFromBuffer(png).toBitmap()
  const px = (x, y) => {
    const o = (Math.round(y) * width + Math.round(x)) * 4
    return [bmp[o + 2], bmp[o + 1], bmp[o]] // BGRA -> RGB
  }

  /* 采样点：标题左右空白、hero 下方、功能卡区域、侧栏 */
  const points = [
    ['标题左侧空白', 360, 140],
    ['标题上方空白', 640, 110],
    ['标题右侧空白', 830, 150],
    ['hero 下方', 640, 215],
    ['功能卡区域', 500, 400],
    ['页面右下', 1300, 700],
    ['侧栏中部', 120, 400],
  ]

  console.log('\n=== 截图实际像素 ===')
  for (const [label, x, y] of points) {
    const [r, g, b] = px(x, y)
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    console.log(
      `  ${label.padEnd(14)} (${x},${y}) → rgb(${r},${g},${b})  亮度 ${lum.toFixed(0)}  ${lum > 140 ? '浅' : '深'}`,
    )
  }

  console.log('\n=== 判定 ===')
  const [r1] = px(640, 110)
  const [r2] = px(640, 215)
  /* 判定跟随目标主题：dark 要求暗底、light 要求亮底，不能一刀切 */
  const wantDark = THEME === 'dark'
  const ok = wantDark ? r1 < 80 && r2 < 80 : r1 > 180 && r2 > 180
  console.log(
    `  画布为${wantDark ? '深色' : '浅色'}:`,
    ok ? 'PASS' : `FAIL (标题上方 rgb=${r1}, hero 下方 rgb=${r2})`,
  )

  app.exit(0)
})

setTimeout(() => {
  console.log('TIMEOUT')
  app.exit(1)
}, 40000)
