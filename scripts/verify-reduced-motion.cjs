/**
 * prefers-reduced-motion 生效性验证。
 *
 * tailwind.css 里以媒体查询关闭了 .px-grad-ember 的漂移动画；
 * 但 CSS 媒体查询只有在系统/模拟开启该偏好时才命中，必须实测，
 * 不能只凭"写了就算数"。
 *
 * 用法：node scripts/verify-reduced-motion.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false })
  const file = path.join(process.cwd(), 'dist', 'index.html').split(path.sep).join('/')
  await win.loadURL('file:///' + file.replace(/^\//, ''))
  await new Promise((r) => setTimeout(r, 2200))

  const js = (c) => win.webContents.executeJavaScript(c)
  const probe = `(function(){
    var h = document.querySelector('[data-slot="pixel-heading"] h2')
    var cs = h ? getComputedStyle(h) : null
    return JSON.stringify({
      anim: cs ? cs.animationName : null,
      dur: cs ? cs.animationDuration : null,
      reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches
    })
  })()`

  console.log('默认          :', await js(probe))

  const dbg = win.webContents.debugger
  try {
    dbg.attach('1.3')
  } catch {
    /* already attached */
  }
  await dbg.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  await new Promise((r) => setTimeout(r, 700))
  console.log('reduced-motion:', await js(probe))

  app.exit(0)
})

setTimeout(() => {
  console.log('TIMEOUT')
  app.exit(1)
}, 30000)
