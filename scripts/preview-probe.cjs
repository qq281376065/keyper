/** 预览实例状态探针：一次性输出 DOM 结构、文本泄漏、运行时错误 */
const http = require('node:http')
const fs = require('node:fs')

const PORT = Number(process.argv[2]) || 9231
const OUT = process.argv[3] || 'preview-state.json'

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
    req.on('timeout', () => req.destroy(new Error('timeout')))
  })
}

const EXPR = `
(() => {
  const q = (s) => document.querySelector(s)
  const text = document.body.innerText || ''
  /* JSX 注释泄漏指纹：界面上出现裸的块注释文本 */
  const leakRe = /\\/\\*[^*]{0,60}\\*\\//g
  const leaks = [...text.matchAll(leakRe)].map((m) => m[0]).slice(0, 8)
  const errRe = /(Error:|Cannot read|is not a function|is not defined|Minified React error)/g
  const errs = [...text.matchAll(errRe)].map((m) => m[0]).slice(0, 5)

  /* 关键容器作用域类齐备性 */
  const scopes = ['shell','s-app','sidebar','rail-toggle','s-tab-bar','s-key-browser','s-value-viewer','s-workspace']
  const scopeState = {}
  for (const s of scopes) {
    const el = document.querySelector('.' + s)
    scopeState[s] = el ? { present: true, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : { present: false }
  }

  /* 顶栏按钮几何（此前出现过"只有图标看不到按钮"的问题） */
  const btns = [...document.querySelectorAll('.bar-btn, .win-close, .rail-toggle')].map((b) => {
    const r = b.getBoundingClientRect()
    const cs = getComputedStyle(b)
    return { cls: b.className, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), visible: cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0, svg: b.querySelectorAll('svg').length }
  })

  return JSON.stringify({
    title: document.title,
    textLen: text.length,
    textHead: text.replace(/\\s+/g, ' ').slice(0, 320),
    leaks,
    errs,
    scopes: scopeState,
    barButtons: btns,
    svgTotal: document.querySelectorAll('svg').length,
    dialogs: document.querySelectorAll('.s-dialog, .dialog').length
  })
})()
`

async function main() {
  const targets = await getJson('/json/list')
  const pg = targets.find((x) => x.type === 'page' && !x.url.startsWith('devtools'))
  if (!pg) {
    console.log('no page target')
    process.exit(1)
  }
  const ws = new WebSocket(pg.webSocketDebuggerUrl)
  const errors = []

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }))
    setTimeout(() => {
      ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: EXPR, returnByValue: true, awaitPromise: false } }))
    }, 150)
  })

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description?.slice(0, 200) || 'exception')
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push((m.params.args || []).map((a) => String(a.value || a.description || '')).join(' ').slice(0, 200))
    }
    if (m.id === 2) {
      const v = m.result?.result?.value
      if (v === undefined) {
        console.log('EVAL FAILED:', JSON.stringify(m.result || {}).slice(0, 400))
      } else {
        const data = JSON.parse(v)
        data.runtimeErrors = errors
        fs.writeFileSync(OUT, JSON.stringify(data, null, 2))
        console.log(JSON.stringify(data, null, 2))
      }
      ws.close()
      process.exit(0)
    }
  })

  setTimeout(() => {
    console.log('timeout')
    process.exit(1)
  }, 8000)
}

main().catch((e) => {
  console.log('ERROR', e.message)
  process.exit(1)
})
