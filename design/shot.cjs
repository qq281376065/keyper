const http = require('http')
const fs = require('fs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdp(port) {
  const list = await new Promise((r) =>
    http.get('http://127.0.0.1:' + port + '/json/list', (s) => {
      let d = ''
      s.on('data', (c) => (d += c))
      s.on('end', () => r(JSON.parse(d)))
    }),
  )
  const pg = list.filter((x) => x.type === 'page')[0]
  const ws = new WebSocket(pg.webSocketDebuggerUrl)
  let n = 0
  const p = new Map()
  const send = (m, ps) =>
    new Promise((r) => {
      const id = ++n
      p.set(id, r)
      ws.send(JSON.stringify({ id, method: m, params: ps }))
    })
  ws.addEventListener('message', (e) => {
    const d = JSON.parse(e.data)
    if (d.id && p.has(d.id)) {
      const r = p.get(d.id)
      p.delete(d.id)
      r(d)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))
  return { send, ws }
}

;(async () => {
  const { send, ws } = await cdp(9482)
  await send('Page.enable', {})
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1240,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await send('Page.navigate', { url: 'http://127.0.0.1:5310/design/sidebar-10-schemes.html' })
  await sleep(3000)

  const ev = async (x) => {
    const d = await send('Runtime.evaluate', { expression: x, returnByValue: true })
    return d.result?.result?.value ?? 'EXC:' + (d.result?.exceptionDetails?.exception?.description || '').slice(0, 200)
  }

  console.log('title:', await ev('document.title'))
  console.log('boxes:', await ev('document.querySelectorAll(".box").length'))
  console.log('rows in first box:', await ev('document.querySelectorAll(".box")[0].querySelectorAll(".row").length'))
  console.log('errors:', await ev('window.__errs ? window.__errs.length : 0'))
  console.log('page height:', await ev('document.body.scrollHeight'))

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  fs.writeFileSync('previews/sidebar-schemes-full.png', Buffer.from(shot.result.data, 'base64'))
  console.log('full shot saved')

  ws.close()
  process.exit(0)
})()
