/**
 * 主页标题接入校验：确认 WelcomePanel 里的 PixelHeading 已生效。
 * 用法：node scripts/check-welcome-title.cjs [port]
 */
const http = require('node:http')

const PORT = Number(process.argv[2]) || 9234

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 5000 }, (res) => {
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
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const r = pending.get(m.id)
      pending.delete(m.id)
      r(m.result?.result?.value)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))

  console.log(
    await ev(`(function(){
      var slot = document.querySelector('[data-slot="pixel-heading"]')
      if (!slot) return JSON.stringify({ found: false, heroHTML: (document.querySelector('.hero-text') || {}).innerHTML ? 'has html' : 'none' })
      var h = slot.querySelector('h1, h2, h3')
      var spans = h ? [].slice.call(h.querySelectorAll('span')) : []
      var cs = h ? getComputedStyle(h) : null
      var fonts = {}
      spans.forEach(function(s){ var f = getComputedStyle(s).fontFamily.split(',')[0].replace(/"/g,''); fonts[f] = (fonts[f]||0)+1 })
      return JSON.stringify({
        found: true,
        tag: h ? h.tagName : null,
        mode: h ? h.dataset.mode : null,
        state: h ? h.dataset.state : null,
        spans: spans.length,
        fontMix: fonts,
        distinctFonts: Object.keys(fonts).length,
        fill: cs ? cs.webkitTextFillColor : null,
        clip: cs ? cs.webkitBackgroundClip : null,
        bgImg: cs ? cs.backgroundImage.slice(0, 72) : null,
        fontSize: cs ? cs.fontSize : null,
        lineHeight: cs ? cs.lineHeight : null,
        slotBox: (function(){ var r = slot.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })()
      }, null, 1)
    })()`),
  )

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.log('ERROR', e.message)
  process.exit(1)
})
