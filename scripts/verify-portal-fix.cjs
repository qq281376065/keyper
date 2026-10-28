/**
 * 验证 portal 浮层随标签切换关闭。
 * 1. 两个标签都切到 db0（有键）
 * 2. A 选 hash 键 → 右键开行菜单
 * 3. 切到 B → 菜单必须消失
 * 4. B 开键右键菜单 → 切回 A → 菜单必须消失
 */
const http = require('node:http')

const PORT = Number(process.argv[2]) || 9231

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

  const OVERLAY = `(() => {
    const sel = '.row-menu, .key-menu, .row-menu-mask, .key-menu-mask'
    const all = [...document.querySelectorAll(sel)]
    const vis = all.filter(m => {
      const r = m.getBoundingClientRect()
      const cs = getComputedStyle(m)
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0
    })
    return JSON.stringify({
      total: all.length,
      visible: vis.length,
      kinds: vis.map(m => m.className.split(' ')[0]),
      activeTab: [...document.querySelectorAll('.tab-strip .tab')].filter(t=>/active/.test(t.className)).map(t=>t.textContent.trim())[0],
    })
  })()`

  /* 把当前激活标签切到 db0 */
  const toDb0 = `(() => {
    const el = [...document.querySelectorAll('.s-workspace')].find(e => getComputedStyle(e).display !== 'none')
    const sel = el && el.querySelector('.db-select')
    if (!sel) return 'no-select'
    sel.value = '0'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return 'db0'
  })()`

  const clickTab = (prefix) => `(() => {
    const t = [...document.querySelectorAll('.tab-strip .tab')].find(x => x.textContent.trim().startsWith('${prefix}'))
    if (!t) return 'no-tab'
    t.click(); return 'ok'
  })()`

  /* 1. 让 A 在自己的会话里落到 db0 并选 hash 键 */
  console.log('A→db0:', await ev(clickTab('A-db0')))
  await wait(1500)
  console.log('切库:', await ev(toDb0))
  await wait(4000)
  console.log(
    'A 选 hash:',
    await ev(`(() => {
      const el = [...document.querySelectorAll('.s-workspace')].find(e => getComputedStyle(e).display !== 'none')
      const leaf = [...el.querySelectorAll('.node-row')].find(r => { const b = r.querySelector('.type-badge'); return b && b.textContent.trim() === 'H' })
      if (!leaf) return 'no-hash'
      leaf.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return 'ok'
    })()`),
  )
  await wait(3000)

  /* 2. A 开行菜单 */
  console.log(
    'A 右键行:',
    await ev(`(() => {
      const el = [...document.querySelectorAll('.s-workspace')].find(e => getComputedStyle(e).display !== 'none')
      const row = el.querySelector('.pair-row')
      if (!row) return 'no-row'
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 700, clientY: 300 }))
      return 'ctx'
    })()`),
  )
  await wait(1200)
  console.log('A 菜单已开:', await ev(OVERLAY))

  /* 3. 切到 B —— 菜单必须关闭 */
  console.log('\n切到 B:', await ev(clickTab('B-db0')))
  await wait(2000)
  console.log('切到 B 后（visible 必须为 0）:', await ev(OVERLAY))

  /* 4. B 切 db0 并开键右键菜单 */
  console.log('\nB 切 db0:', await ev(toDb0))
  await wait(4000)
  console.log(
    'B 开键菜单:',
    await ev(`(() => {
      const el = [...document.querySelectorAll('.s-workspace')].find(e => getComputedStyle(e).display !== 'none')
      const row = el.querySelector('.node-row')
      if (!row) return 'no-row'
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }))
      return 'ctx'
    })()`),
  )
  await wait(1200)
  console.log('B 键菜单已开:', await ev(OVERLAY))

  console.log('\n切回 A:', await ev(clickTab('A-db0')))
  await wait(2000)
  console.log('切回 A 后（visible 必须为 0）:', await ev(OVERLAY))

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.log('ERROR', e.message)
  process.exit(1)
})
