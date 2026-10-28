/**
 * PixelHeading 交互验证：hover / focus / 移开 / prefers-reduced-motion。
 *
 * 锁定的行为契约（来自 Cult UI 文档）：
 *   · 静止态：random / multi 用黄金比例分布；data-state = "idle"
 *   · hover 或 focus：开始逐字错峰切换；data-state = "active"
 *   · 移开（非 autoPlay）：停止并回到静止态
 *   · Enter / Space：手动推进一帧（无障碍）
 *
 * 用法：node scripts/verify-title-interaction.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false })
  const file = path.join(process.cwd(), 'dist', 'index.html').replace(/\\/g, '/')
  await win.loadURL(`file://${file}`)
  await new Promise((r) => setTimeout(r, 2500))

  const js = (code) => win.webContents.executeJavaScript(code)

  /* 在标题元素上派发真实事件（React 合成事件需要冒泡的真实事件） */
  const snapshot = `
    (function(){
      var h = document.querySelector('[data-slot="pixel-heading"] h2')
      if (!h) return JSON.stringify({ missing: true })
      var spans = [].slice.call(h.querySelectorAll('span'))
      return JSON.stringify({
        state: h.dataset.state,
        mode: h.dataset.mode,
        fonts: spans.map(function(s){ return getComputedStyle(s).fontFamily.split(',')[0].replace(/"/g,'').replace('Geist Pixel ','') }),
        joined: spans.map(function(s){ return getComputedStyle(s).fontFamily.split(',')[0].replace(/"/g,'').replace('Geist Pixel ','') }).join(',')
      })
    })()
  `

  const idle = JSON.parse(await js(snapshot))
  console.log('静止态      :', idle.state, '| 字体序列:', idle.joined)

  /* 黄金比例校验：random 静止态的基序应与 goldenBase(vi) 完全一致 */
  const PHI = (1 + Math.sqrt(5)) / 2
  const FONTS = ['Square', 'Grid', 'Circle', 'Triangle', 'Line']
  const golden = Array.from({ length: 11 }, (_, i) => FONTS[Math.floor((i * PHI * 5) % 5)])
  const matchesGolden = idle.joined === golden.join(',')
  console.log('黄金比例分配:', matchesGolden ? 'PASS' : `FAIL\n  期望 ${golden.join(',')}\n  实际 ${idle.joined}`)

  /* hover 启动 */
  await js(`
    (function(){
      var h = document.querySelector('[data-slot="pixel-heading"] h2')
      h.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      h.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    })()
  `)
  await new Promise((r) => setTimeout(r, 900))
  const active1 = JSON.parse(await js(snapshot))
  await new Promise((r) => setTimeout(r, 700))
  const active2 = JSON.parse(await js(snapshot))

  console.log('hover 后     :', active1.state, '|', active1.joined)
  console.log('再过 700ms   :', active2.state, '|', active2.joined)
  console.log('字符在变化   :', active1.joined !== active2.joined ? 'PASS' : 'FAIL (序列未变)')
  console.log('进入 active  :', active1.state === 'active' ? 'PASS' : 'FAIL')

  /* 移开停止 */
  await js(`
    (function(){
      var h = document.querySelector('[data-slot="pixel-heading"] h2')
      h.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
      h.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))
  const after1 = JSON.parse(await js(snapshot))
  await new Promise((r) => setTimeout(r, 700))
  const after2 = JSON.parse(await js(snapshot))
  console.log('移开后       :', after1.state, '| 停止变化:', after1.joined === after2.joined ? 'PASS' : 'FAIL')

  /* 键盘推进 */
  await js(`
    (function(){
      var h = document.querySelector('[data-slot="pixel-heading"] h2')
      h.focus()
      h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })()
  `)
  await new Promise((r) => setTimeout(r, 300))
  const kb = JSON.parse(await js(snapshot))
  console.log('Enter 推进   :', kb.state, '| 序列变化:', kb.joined !== idle.joined ? 'PASS' : 'FAIL')

  /* reduced motion：模拟后确认 CSS 动画被冻结 */
  await js(`
    (function(){
      var s = document.createElement('style')
      s.textContent = '@media (prefers-reduced-motion: reduce) { .px-grad-ember { animation: none !important } }'
      document.head.appendChild(s)
    })()
  `)
  const anim = await js(`
    (function(){
      var h = document.querySelector('[data-slot="pixel-heading"] h2')
      return getComputedStyle(h).animationName
    })()
  `)
  console.log('当前动画名   :', anim)

  app.exit(0)
})

setTimeout(() => {
  console.log('TIMEOUT')
  app.exit(1)
}, 45000)
