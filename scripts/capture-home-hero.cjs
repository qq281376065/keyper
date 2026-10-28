/**
 * 独立截图：启动自己的 BrowserWindow 加载应用主页，截 hero 区域。
 * 不依赖已运行实例（那些实例的 Page.captureScreenshot 偶发不响应）。
 *
 * 用法：node scripts/capture-home-hero.cjs [light|dark] [out.png]
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const THEME = process.argv[2] || 'dark'
const OUT = process.argv[3] || `preview-${THEME}.png`

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: THEME === 'dark' ? '#15171c' : '#f4f5f7',
  })
  const url = `file://${path.join(process.cwd(), 'dist', 'index.html').replace(/\\/g, '/')}`
  await win.loadURL(url)
  await new Promise((r) => setTimeout(r, 2500))

  await win.webContents.executeJavaScript(
    `document.documentElement.dataset.theme='${THEME}';document.documentElement.style.colorScheme='${THEME}'`,
  )
  /* capturePage 返回上一次合成的帧：只改 CSS 变量不会立刻产生新表面，
     必须等两帧 rAF 并触发一次 resize，否则截到旧主题（曾导致误判"深色主题仍是白底"）。*/
  await win.webContents.executeJavaScript(
    'new Promise(function(resolve){ requestAnimationFrame(function(){ requestAnimationFrame(function(){ resolve(1) }) }) })'
  )
  win.setSize(1441, 901)
  await new Promise((r) => setTimeout(r, 350))
  win.setSize(1440, 900)
  await new Promise((r) => setTimeout(r, 1300))

  const info = JSON.parse(
    await win.webContents.executeJavaScript(`(function(){
      var slot = document.querySelector('[data-slot="pixel-heading"]')
      if (!slot) return JSON.stringify({ found:false, hero:(document.querySelector('.hero-text')||{}).innerText })
      var h = slot.querySelector('h1,h2,h3')
      var r = h.getBoundingClientRect()
      var cs = getComputedStyle(h)
      return JSON.stringify({
        found:true, fontSize:cs.fontSize,
        box:{ x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height) },
        win:{ w:window.innerWidth, h:window.innerHeight }
      })
    })()`),
  )
  console.log('INFO:', JSON.stringify(info))

  if (!info.found) {
    console.log('PixelHeading not mounted; aborting')
    app.exit(1)
    return
  }

  const img = await win.webContents.capturePage()
  const full = img.toPNG()
  const { width, height } = img.getSize()
  fs.writeFileSync(`${OUT}.full.png`, full)

  // 裁出 hero（含左侧 logo 与副标题）
  const crop = {
    x: Math.max(0, info.box.x - 110),
    y: Math.max(0, info.box.y - 14),
    width: Math.min(info.box.w + 160, width - Math.max(0, info.box.x - 110)),
    height: Math.min(info.box.h + 52, height - Math.max(0, info.box.y - 14)),
  }
  const cut = nativeImage.createFromBuffer(full).crop(crop)
  fs.writeFileSync(OUT, cut.toPNG())
  console.log('saved:', OUT, cut.getSize(), '| full:', { width, height })

  app.exit(0)
})

setTimeout(() => {
  console.log('TIMEOUT')
  app.exit(1)
}, 40000)
