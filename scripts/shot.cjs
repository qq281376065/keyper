/** 单次截图：抓指定调试端口页面的整屏 PNG */
const http = require('http')
const fs = require('fs')
const PORT = Number(process.argv[2]) || 9231
const OUT = process.argv[3] || 'live-topbar.png'

http
  .get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (res) => {
    let d = ''
    res.on('data', (c) => (d += c))
    res.on('end', () => {
      const t = JSON.parse(d)
      const pg = t.find((x) => x.type === 'page' && x.url.indexOf('devtools') !== 0)
      if (!pg) return console.log('no page')
      const ws = new WebSocket(pg.webSocketDebuggerUrl)
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }))
        ws.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: { format: 'png' } }))
      })
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id === 2 && m.result) {
          fs.writeFileSync(OUT, Buffer.from(m.result.data, 'base64'))
          console.log('saved:', OUT)
          ws.close()
          process.exit(0)
        }
      })
      setTimeout(() => {
        console.log('timeout')
        process.exit(1)
      }, 25000)
    })
  })
  .on('error', (e) => console.log('fail', e.code))
