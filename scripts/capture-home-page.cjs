/**
 * 主页整页截图（含主题强制重绘），用于最终视觉复核。
 * 用法：node scripts/capture-home-page.cjs [light|dark] [out.png]
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const THEME = process.argv[2] || 'dark'
const OUT = process.argv[3] || `home-${THEME}.png`

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
  await new Promise((r) => setTimeout(r, 2600))

  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-theme','${THEME}');` +
      `document.documentElement.style.colorScheme='${THEME}';`,
  )
  /* capturePage 返回上一次合成的帧：等两帧 rAF 并抖一次尺寸，确保新主题已合成 */
  await win.webContents.executeJavaScript(
    'new Promise(function(res){requestAnimationFrame(function(){requestAnimationFrame(function(){res(1)})})})',
  )
  win.setSize(1441, 901)
  await new Promise((r) => setTimeout(r, 350))
  win.setSize(1440, 900)
  await new Promise((r) => setTimeout(r, 1300))

  const img = await win.webContents.capturePage()
  fs.writeFileSync(OUT, img.toPNG())
  console.log('saved:', OUT, img.getSize())

  app.exit(0)
})

setTimeout(() => {
  console.log('TIMEOUT')
  app.exit(1)
}, 40000)
