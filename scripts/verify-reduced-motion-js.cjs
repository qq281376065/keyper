/**
 * prefers-reduced-motion 对「逐字符字体切换」（JS 定时器）的生效性验证。
 *
 * CSS 媒体查询能冻结渐变的 px-sweep 动画，但 PixelHeading 的字体切换是
 * setInterval 驱动的，CSS 管不到 —— 必须在组件里判断该偏好。
 * 本脚本在模拟 reduced-motion 下 hover 标题，断言字体序列不变。
 *
 * 用法：node scripts/verify-reduced-motion-js.cjs
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

  const seq = `(function(){
    var h = document.querySelector('[data-slot="pixel-heading"] h2')
    if (!h) return JSON.stringify({ missing: true })
    var spans = [].slice.call(h.querySelectorAll('span'))
    return JSON.stringify({
      state: h.dataset.state,
      joined: spans.map(function(s){
        return getComputedStyle(s).fontFamily.split(',')[0].replace(/"/g,'').replace('Geist Pixel ','')
      }).join(',')
    })
  })()`

  /* 开启 reduced-motion 模拟 */
  const dbg = win.webContents.debugger
  try {
    dbg.attach('1.3')
  } catch {
    /* already attached */
  }
  await dbg.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  await new Promise((r) => setTimeout(r, 500))

  const reduced = await js(`window.matchMedia('(prefers-reduced-motion: reduce)').matches`)
  console.log('reduced-motion 生效:', reduced)

  const before = JSON.parse(await js(seq))
  console.log('偏好开启后（autoPlay 应已停摆）:', before.state, '| 字体:', before.joined)

  /* hover 触发（React 合成事件需要冒泡的真实事件） */
  await js(`(function(){
    var h = document.querySelector('[data-slot="pixel-heading"] h2')
    h.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })()`)
  await new Promise((r) => setTimeout(r, 1200))
  const mid = JSON.parse(await js(seq))
  await new Promise((r) => setTimeout(r, 1000))
  const after = JSON.parse(await js(seq))

  console.log('hover 1.2s:', mid.state, '| 字体:', mid.joined)
  console.log('hover 2.2s:', after.state, '| 字体:', after.joined)

  /* autoPlay 开启后，"hover 前"本身可能已是 active（正在播放）。
     真正要断言的是：偏好生效后**停止变化**，而不是与初始快照相同。 */
  const stable = mid.joined === after.joined
  const notActive = after.state !== 'active'
  console.log('字体序列保持不动:', stable ? 'PASS' : 'FAIL')
  console.log('未进入 active 态:', notActive ? 'PASS' : `FAIL (state=${after.state})`)

  app.exit(0)
})

setTimeout(() => {
  console.log('TIMEOUT')
  app.exit(1)
}, 35000)
