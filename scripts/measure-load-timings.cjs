/**
 * 连接与首屏键加载的耗时分解。
 *
 * 目的：把「连上」和「看到键」拆成可测量的阶段，定位真实瓶颈，
 * 而不是凭感觉优化。
 *
 * 测量点（均在渲染层可观测）：
 *   T0 点击连接（用户动作）
 *   T1 连接状态变 connected（主进程 connect 返回）
 *   T2 键列表出现首屏数据（state.keys.length > 0）
 *   T3 键列表"已全部加载"（cursor 归零）
 *   T4 选中键后值区出现内容
 *
 * 用法：node scripts/measure-load-timings.cjs [port] [connIndex]
 */
const http = require('node:http')

const PORT = Number(process.argv[2]) || 9245
const IDX = Number(process.argv[3]) || 0

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
  const ev = (e) =>
    new Promise((r) => {
      const id = ++seq
      pend.set(id, r)
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true } }))
    })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      const r = pend.get(m.id)
      pend.delete(m.id)
      r(m.result?.result?.value)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))

  /* 先断开并关掉所有标签，保证每次测量都从"未连接"开始 */
  await ev(`(function(){
    var tabs=[].slice.call(document.querySelectorAll('.tab-strip .tab:not(.tab-home)'))
    tabs.forEach(function(t){ var b=t.querySelector('.tl-close,button'); if(b) b.click() })
    return tabs.length
  })()`)
  await wait(2500)
  /* 二次确认：连接项必须已回到未连接态，否则测量会读到旧状态 */
  const ready = await ev(`(function(){
    var items=[].slice.call(document.querySelectorAll('.conn-item'))
    return items.length > 0 && !items.some(function(i){ return /is-connected/.test(i.className) })
  })()`)
  if (!ready) {
    console.log('警告：仍存在已连接项，本次测量可能不准')
  }

  /* 在页面里装一个探针，用 MutationObserver + 轮询记录关键时间点 */
  await ev(`(function(){
    window.__t = { t0: performance.now() }
    var t = window.__t
    var iv = setInterval(function(){
      var item = document.querySelectorAll('.conn-item')[${IDX}]
      if (t.t1 === undefined && item && /is-connected/.test(item.className)) t.t1 = performance.now()
      var foot = document.querySelector('.list-foot')
      var txt = foot ? foot.innerText : ''
      var m = /已加载\\s+(\\d+)/.exec(txt)
      if (t.t2 === undefined && m && Number(m[1]) > 0) t.t2 = performance.now()
      if (t.t3 === undefined && /已全部加载/.test(txt)) t.t3 = performance.now()
      var vv = document.querySelector('.s-value-viewer')
      var key = vv && vv.querySelector('.key-name')
      if (t.t4 === undefined && key && key.textContent.trim()) t.t4 = performance.now()
      if (t.t3 !== undefined && t.t4 !== undefined) clearInterval(iv)
    }, 16)
    window.__tIv = iv
    return 'probe installed'
  })()`)

  /* 触发连接 */
  const t0 = Date.now()
  await ev(`(function(){
    var item = document.querySelectorAll('.conn-item')[${IDX}]
    if (!item) return 'no-item'
    item.click()
    return 'clicked'
  })()`)

  /* 点击后立刻选一个键（模拟用户"连上就看值"） */
  let picked = false
  for (let i = 0; i < 120; i++) {
    await wait(100)
    if (picked) continue
    const ok = await ev(`(function(){
      var rows=[].slice.call(document.querySelectorAll('.node-row')).filter(function(r){return !/folder/.test(r.className)})
      if (!rows.length) return false
      rows[0].dispatchEvent(new MouseEvent('click',{bubbles:true}))
      return true
    })()`)
    if (ok) picked = true
    const done = await ev(`(function(){
      var t=window.__t||{}
      return !!(t.t3 !== undefined && t.t4 !== undefined)
    })()`)
    if (done) break
  }

  const timings = JSON.parse(await ev(`JSON.stringify(window.__t)`))
  await ev(`clearInterval(window.__tIv)`)

  const rel = (v) => (v === undefined ? null : Math.round(v - timings.t0))
  console.log('=== 阶段耗时（相对点击时刻，毫秒）===')
  console.log('  T1 连接已建立        :', rel(timings.t1))
  console.log('  T2 首屏键出现        :', rel(timings.t2))
  console.log('  T3 键全部加载完成    :', rel(timings.t3))
  console.log('  T4 值区出现内容      :', rel(timings.t4))
  console.log('')
  console.log('  connect  → 首屏键    :', timings.t1 && timings.t2 ? Math.round(timings.t2 - timings.t1) : null, 'ms')
  console.log('  首屏键    → 全部加载 :', timings.t2 && timings.t3 ? Math.round(timings.t3 - timings.t2) : null, 'ms')
  console.log('  全部加载  → 值区     :', timings.t3 && timings.t4 ? Math.round(timings.t4 - timings.t3) : null, 'ms')
  console.log('  总计（点击→值区）    :', rel(timings.t4), 'ms')
  console.log('  墙钟（脚本侧）       :', Date.now() - t0, 'ms')

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.log('ERROR', e.message)
  process.exit(1)
})
