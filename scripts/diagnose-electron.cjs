/**
 * Electron 真实窗口的综合诊断探针。
 *
 * 连接 --remote-debugging-port=9229 的真实窗口（Vite dev + IPC + ioredis 全链路），
 * 输出三类证据：
 *   A. 性能：长任务（>50ms 阻塞）、内存、首屏耗时
 *   B. 运行时错误：console.error / 异常（含 React 警告）
 *   C. 弹窗几何：每个打开的弹窗，检查子元素是否溢出弹窗边界（错位的量化判据）
 *
 * 用法：node scripts/diagnose-electron.cjs [操作脚本名]
 * 操作脚本（actions/）：connect / dialogs / browse —— 见目录内文件。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = process.argv[2] ? Number(process.argv[2]) : 9229
const ACTION = process.argv[3] || 'connect'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

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
  let targets = null
  for (let i = 0; i < 20; i++) {
    try {
      targets = await getJson('/json/list')
      if (targets?.length) break
    } catch {}
    await wait(300)
  }
  const page = targets.filter((t) => t.type === 'page').find((t) => /RedisDocter|127/.test(t.url) || t.url.includes('5173')) || targets.find((t) => t.type === 'page')
  if (!page) {
    console.log('未找到页面，targets:', targets?.map((t) => t.type + ':' + t.url))
    return
  }
  console.log('页面:', page.url)

  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const errors = []
  const longTasks = []

  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300))
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)
      if (m.params.type === 'error') errors.push('ERR ' + txt)
      if (m.params.type === 'warning' && /react|key|invalid|fail/i.test(txt)) errors.push('WARN ' + txt)
    }
  })

  const send = (method, params = {}) => {
    const mid = ++id
    ws.send(JSON.stringify({ id: mid, method, params }))
    return new Promise((r) => pending.set(mid, r))
  }
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) return 'EVAL-ERR ' + (res.result.exceptionDetails.exception?.description || '').slice(0, 200)
    return res.result?.result?.value
  }

  await send('Runtime.enable')
  await send('Page.enable')

  /* ---------------------------------------------------------------- 性能基线 */
  // PerformanceObserver 记录长任务（>50ms 的主线程阻塞 = 掉帧/卡顿的直接来源）
  await evaluate(`
    (function () {
      window.__perf = { longTasks: [], navStart: performance.timeOrigin }
      try {
        new PerformanceObserver(function (list) {
          for (var i = 0; i < list.getEntries().length; i++) {
            var e = list.getEntries()[i]
            window.__perf.longTasks.push({ dur: Math.round(e.duration), start: Math.round(e.startTime) })
          }
        }).observe({ entryTypes: ['longtask'] })
      } catch (e) { /* 环境不支持则跳过 */ }
      return 'observers-ready'
    })()
  `)

  /* ---------------------------------------------------------------- 弹窗几何检查器（注入后长期可用） */
  await evaluate(`
    (function () {
      window.__checkDialogGeometry = function () {
        var results = []
        var dialogs = [].slice.call(document.querySelectorAll('.dialog'))
        dialogs.forEach(function (dlg, di) {
          var dr = dlg.getBoundingClientRect()
          var overflow = []
          var els = dlg.querySelectorAll('*')
          for (var i = 0; i < els.length; i++) {
            var el = els[i]
            if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue
            var r = el.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) continue
            // 误报排除：处于滚动容器内部的子元素溢出弹窗边界属于正常滚动内容
            var scrollAncestor = el.parentElement
            var scrollable = false
            while (scrollAncestor && scrollAncestor !== dlg) {
              var scs = getComputedStyle(scrollAncestor)
              if (scs.overflowY === 'auto' || scs.overflowY === 'scroll' || scs.overflowX === 'auto' || scs.overflowX === 'scroll') { scrollable = true; break }
              scrollAncestor = scrollAncestor.parentElement
            }
            if (scrollable) continue
            // 判据：子元素超出弹窗边界 > 2px（容忍亚像素）
            var overL = dr.left - r.left
            var overR = r.right - dr.right
            var overT = dr.top - r.top
            var overB = r.bottom - dr.bottom
            var worst = Math.max(overL, overR, overT, overB)
            if (worst > 2) {
              overflow.push({
                tag: el.tagName.toLowerCase(),
                cls: (el.className || '').toString().slice(0, 40),
                over: Math.round(worst),
                dir: overL > 2 ? 'left' : overR > 2 ? 'right' : overT > 2 ? 'top' : 'bottom',
              })
            }
          }
          results.push({
            idx: di,
            w: Math.round(dr.width),
            h: Math.round(dr.height),
            overflowCount: overflow.length,
            top3: overflow.slice(0, 3),
          })
        })
        return results
      }
      return 'geometry-ready'
    })()
  `)

  /* ---------------------------------------------------------------- 操作脚本 */
  const actionPath = path.join(__dirname, 'actions', ACTION + '.cjs')
  if (fs.existsSync(actionPath)) {
    const runAction = require(actionPath)
    await runAction({ evaluate, wait, send })
  } else {
    console.log('（无动作脚本，仅做静态检查）')
  }

  /* ---------------------------------------------------------------- 汇总 */
  const perf = await evaluate('JSON.stringify({ longTasks: window.__perf.longTasks, mem: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1 })')
  const geo = await evaluate('JSON.stringify(window.__checkDialogGeometry())')
  const dom = await evaluate('JSON.stringify({ connItems: document.querySelectorAll(".conn-item").length, tabs: document.querySelectorAll(".tab").length, keys: document.querySelectorAll(".node-row,.key-item").length, dialogs: document.querySelectorAll(".dialog").length })')

  console.log('\n=== A. 性能 ===')
  const perfData = JSON.parse(perf)
  console.log('长任务(>50ms):', JSON.stringify(perfData.longTasks))
  console.log('JS 堆内存(MB):', perfData.mem)

  console.log('\n=== B. 运行时错误 ===')
  console.log(errors.length ? errors.slice(0, 10).join('\n') : '(无)')

  console.log('\n=== C. 弹窗几何 ===')
  const geoData = JSON.parse(geo)
  console.log(geoData.length ? JSON.stringify(geoData, null, 1) : '(当前无打开的弹窗)')

  console.log('\n=== D. DOM 概况 ===')
  console.log(dom)

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    fs.writeFileSync(path.join(process.cwd(), `diag-${ACTION}.png`), Buffer.from(shot.result.data, 'base64'))
  }
  ws.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
