/**
 * CPU 采样：定位"点开大 JSON 键"时的真实热点函数。
 *
 * 前面的排查已经排除了：DOM 节点数（已降到 75）、prettyJson（实测 0ms）、
 * 网络（主进程取值 43ms）、Blob 统计（已 useMemo 化）。
 * 但长任务仍有 1.1–1.7 秒，必须靠 CPU profile 找真正的热点，
 * 而不是继续猜。
 *
 * 用法：node scripts/profile-key-click.cjs [port] [keyName]
 */
const http = require('node:http')

const PORT = Number(process.argv[2]) || 9263
const KEY = process.argv[3] || 'getConfigPri'

function getJson(p) {
  return new Promise((res, rej) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 5000 }, (s) => {
      let d = ''
      s.on('data', (c) => (d += c))
      s.on('end', () => {
        try {
          res(JSON.parse(d))
        } catch (e) {
          rej(e)
        }
      })
    })
    r.on('error', rej)
  })
}

async function main() {
  const targets = await getJson('/json/list')
  const pg = targets.find((x) => x.type === 'page' && !x.url.startsWith('devtools'))
  const ws = new WebSocket(pg.webSocketDebuggerUrl)
  let seq = 0
  const pend = new Map()
  const send = (method, params) =>
    new Promise((r) => {
      const id = ++seq
      pend.set(id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r?.result?.value
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      const r = pend.get(m.id)
      pend.delete(m.id)
      r(m.result)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))

  await send('Profiler.enable', {})
  await send('Profiler.setSamplingInterval', { interval: 200 }) // 200µs 采样
  await send('Profiler.start', {})

  await ev(`(function(){
    var rows=[].slice.call(document.querySelectorAll('.s-key-browser .node-row')).filter(function(r){return !/folder/.test(r.className)})
    var t=rows.find(function(r){var l=r.querySelector('.label');return l && l.textContent.indexOf(${JSON.stringify(KEY)})>=0})
    if (t) t.dispatchEvent(new MouseEvent('click',{bubbles:true}))
    return t ? 'clicked' : 'not-found'
  })()`)

  await wait(4000)

  const res = await send('Profiler.stop', {})
  const profile = res?.profile
  if (!profile) {
    console.log('profile 为空，返回结构:', JSON.stringify(res).slice(0, 200))
    process.exit(1)
  }

  /* 按 self time 聚合 */
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const selfTime = new Map()
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i])
    if (!n) continue
    const dt = (profile.timeDeltas[i] || 0) / 1000 // µs → ms
    const cf = n.callFrame
    const key = `${cf.functionName || '(anonymous)'}  @${(cf.url || '').split('/').pop()}:${cf.lineNumber + 1}`
    selfTime.set(key, (selfTime.get(key) || 0) + dt)
  }

  const total = [...selfTime.values()].reduce((a, b) => a + b, 0)
  const top = [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)

  console.log(`=== CPU 热点（总采样 ${total.toFixed(0)}ms）===`)
  for (const [k, v] of top) {
    const pct = ((v / total) * 100).toFixed(1)
    console.log(`  ${v.toFixed(0).padStart(6)}ms  ${pct.padStart(5)}%  ${k}`)
  }

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.log('ERROR', e.message)
  process.exit(1)
})
