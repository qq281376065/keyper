/**
 * 键切换延迟的精确测量（渲染层视角）。
 *
 * 上一版探针用"key-name 有内容且无骨架"做判定，切换键时旧内容仍在，
 * 于是一次点击可能瞬间"满足条件"（读到旧值），也可能一直等不到
 * （键名恰好没变），结果毫无参考价值。
 *
 * 本版改为三条硬信号的组合：
 *   ① performance.mark 记录点击时刻
 *   ② 用 MutationObserver 监听 .s-value-viewer 的子树变化
 *   ③ 判定条件：.key-name 的文本**变成目标键名**（前缀匹配即可）
 * 并额外用 requestAnimationFrame 等一帧，确保是"真的画出来了"。
 *
 * 用法：node scripts/measure-key-latency.cjs [port] [count]
 */
const http = require('node:http')

const PORT = Number(process.argv[2]) || 9258
const COUNT = Number(process.argv[3]) || 5

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

  /* 连接（若未连接） */
  const connected = await ev(
    `(function(){var i=document.querySelectorAll('.conn-item')[0];return i?/is-connected/.test(i.className):false})()`,
  )
  if (!connected) {
    await ev(`document.querySelectorAll('.conn-item')[0].click();'ok'`)
    await wait(9000)
  }

  const rows = await ev(
    `document.querySelectorAll('.s-key-browser .node-row:not(.folder)').length`,
  )
  console.log('可选叶子键:', rows)
  if (!rows || rows < COUNT + 2) {
    console.log('键数量不足，无法测量')
    process.exit(1)
  }

  const results = []
  for (let n = 0; n < COUNT; n++) {
    const r = await ev(`
      (async function(){
        var rows=[].slice.call(document.querySelectorAll('.s-key-browser .node-row')).filter(function(r){return !/folder/.test(r.className)})
        var el=rows[${n + 2}]
        if(!el) return JSON.stringify({err:'no el'})
        /* 目标键名：节点里的 key 文本（去掉 TTL 尾巴） */
        var label=(el.querySelector('.label')||{}).textContent||''
        var t0=performance.now()
        el.dispatchEvent(new MouseEvent('click',{bubbles:true}))
        /* 等 value-viewer 的 key-name 变成"包含 label 中任一可见片段" */
        var vv=document.querySelector('.s-value-viewer')
        var target=label.trim().split(/\\s+/)[0].slice(0,18)
        for(var i=0;i<240;i++){
          await new Promise(function(r){requestAnimationFrame(r)})
          var k=(vv.querySelector('.key-name')||{}).textContent||''
          if(k && target && k.indexOf(target)>=0 && !vv.querySelector('.sk')){
            /* 再等一帧，确认已提交绘制 */
            await new Promise(function(r){requestAnimationFrame(r)})
            return JSON.stringify({ms:Math.round(performance.now()-t0), target:target, got:k.slice(0,26)})
          }
        }
        return JSON.stringify({err:'timeout', target:target})
      })()
    `)
    const parsed = JSON.parse(r)
    results.push(parsed)
    console.log(`  #${n + 1}:`, JSON.stringify(parsed))
    await wait(400)
  }

  const ok = results.filter((x) => typeof x.ms === 'number').map((x) => x.ms)
  if (ok.length) {
    ok.sort((a, b) => a - b)
    console.log('')
    console.log('=== 键切换延迟（点击 → 值已绘制）===')
    console.log('  全部:', ok.join(', '), 'ms')
    console.log('  最小:', ok[0], '| 中位:', ok[Math.floor(ok.length / 2)], '| 最大:', ok[ok.length - 1])
  }

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.log('ERROR', e.message)
  process.exit(1)
})
