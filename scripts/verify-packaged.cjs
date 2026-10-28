/**
 * 真机验证：对打包后的 win-unpacked 启动的实例做多标签断言。
 * 与 scripts/repro-db-switch.cjs 同思路，但只读、不改配置。
 */
const http = require('node:http')

const PORT = Number(process.argv[2]) || 9232

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 4000 }, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(d))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
  })
}

async function main() {
  const targets = await getJson('/json/list')
  const pg = targets.find((x) => x.type === 'page' && !x.url.startsWith('devtools'))
  const ws = new WebSocket(pg.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  const ev = (expression) =>
    new Promise((r) => {
      const id = ++seq
      pending.set(id, r)
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const r = pending.get(m.id)
      pending.delete(m.id)
      r(m.result?.result?.value)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))

  const STATE = `(() => {
    const ws = [...document.querySelectorAll('.s-workspace')]
    const vis = ws.filter(e => getComputedStyle(e).display !== 'none')
    const overlay = [...document.querySelectorAll('.row-menu, .key-menu')].filter(m => {
      const r = m.getBoundingClientRect(); return r.width > 0 && getComputedStyle(m).display !== 'none'
    })
    return JSON.stringify({
      tabCount: document.querySelectorAll('.tab-strip .tab').length,
      wsTotal: ws.length,
      wsVisible: vis.length,
      overlayVisible: overlay.length,
      activeTab: [...document.querySelectorAll('.tab-strip .tab')].filter(t=>/active/.test(t.className)).map(t=>t.textContent.trim())[0] || null,
      wsBoxes: ws.map(e => { const r = e.getBoundingClientRect(); return { d: getComputedStyle(e).display, w: Math.round(r.width) } }),
    })
  })()`

  console.log('初始:', await ev(STATE))

  /* 连两个连接 */
  const n = await ev("document.querySelectorAll('.conn-item').length")
  console.log('连接项:', n)
  if (n >= 2) {
    await ev("document.querySelectorAll('.conn-item')[0].click(); 'a'")
    await wait(6000)
    console.log('连 A 后:', await ev(STATE))
    await ev("document.querySelectorAll('.conn-item')[1].click(); 'b'")
    await wait(6000)
    console.log('连 B 后（wsVisible 必须为 1）:', await ev(STATE))

    /* 切标签 */
    await ev(`(() => { const t=[...document.querySelectorAll('.tab-strip .tab')].filter(x=>!x.classList.contains('tab-home')); if(t[0]) t[0].click(); return 'ok' })()`)
    await wait(2000)
    console.log('切回首个标签:', await ev(STATE))
  }

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.log('ERROR', e.message)
  process.exit(1)
})
