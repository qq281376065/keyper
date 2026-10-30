/**
 * 可操作方案（01 静浮 / 09 升起）· 真实鼠标交互探针
 *
 * 这两张卡和其余八套不同：阴影不是画上去的静态态，而是 :hover / :active
 * 真实响应。所以必须用 CDP 的 Input.dispatchMouseEvent 真的把鼠标移过去，
 * 只读 computed style 是测不出来的（没有鼠标事件，:hover 永不成立）。
 *
 * 两套手感刻意不同，断言也分开：
 *   01 静浮 —— hover 只加影、**不位移**（静）；按下把影子收干净
 *   09 升起 —— hover 出影且**上浮 1px**（动）；按下压回原位
 *
 * 每套都验：
 *   A. 初始：第 1 个无影、第 3 个激活态有影
 *   B. 悬停第 1 个：出影（09 另有 -1px 位移）
 *   C. 移开：影子回到 none、位移归零
 *   D. 按下：01 收影、09 压回 0
 *   E. 点击第 2 个：激活态转移
 * 另验：只有这两张卡是手型光标，其余保持默认。
 *
 * 不截图。用法：node scripts/check-tab-lift.mjs（需 5320 端口服务）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const URL = 'http://127.0.0.1:5320/tab-shadow-10.html'
const CHROME = 'C:/Users/admin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const PORT = 9451

const CARDS = [
  { p: 1, name: '01 静浮', lift: false },
  { p: 9, name: '09 升起', lift: true },
]

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + fs.mkdtempSync('C:/Users/admin/AppData/Local/Temp/cdp-lift-'),
  '--no-first-run', '--disable-gpu', '--no-proxy-server',
  '--window-size=1400,1200', 'about:blank',
])
await new Promise((r) => setTimeout(r, 6500))

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let id = 0
const pending = new Map()
const errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  }
}
const send = (method, params = {}) => {
  const mid = ++id
  ws.send(JSON.stringify({ id: mid, method, params }))
  return new Promise((r) => pending.set(mid, r))
}
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || '').slice(0, 300) }
  return r.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: URL })
await new Promise((r) => setTimeout(r, 1700))

const out = []
const ok = (name, cond, detail) => out.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) })

const moveTo = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await new Promise((r) => setTimeout(r, 230))
}
const pressAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await new Promise((r) => setTimeout(r, 200))
}
const releaseAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
  await new Promise((r) => setTimeout(r, 260))
}

/* 取某套卡第 n 个页签的视口坐标 + 阴影 + 位移 */
const tabInfo = (p, n) => ev(`
(() => {
  const bar = document.querySelector('.plan[data-p="${p}"] .tbar');
  const tabs = [...bar.querySelectorAll('.tab')];
  const t = tabs[${n}];
  const r = t.getBoundingClientRect();
  const cs = getComputedStyle(t);
  const m = (cs.transform || '').match(/matrix\\(1, 0, 0, 1, ([-\\d.]+), ([-\\d.]+)\\)/);
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    shadow: cs.boxShadow,
    ty: m ? +parseFloat(m[2]).toFixed(2) : 0,
    isOn: t.classList.contains('on'),
    count: tabs.length,
  };
})()`)

for (const card of CARDS) {
  const tag = card.name + ' · '

  /* 先滚进视口：十张卡纵向排到 2000px 开外，而鼠标事件用的是视口坐标，
     卡片在视口外时坐标无效、:hover 永远不成立 */
  await ev(`document.querySelector('.plan[data-p="${card.p}"]').scrollIntoView({ block: 'center' })`)
  await new Promise((r) => setTimeout(r, 430))
  await moveTo(5, 5)

  const a0 = await tabInfo(card.p, 0)
  const a1 = await tabInfo(card.p, 2)
  ok(tag + '已滚入视口', a0.y > 0 && a0.y < 1200, 'y=' + a0.y)
  ok(tag + '四个页签', a0.count === 4, a0.count)
  ok(tag + '初始第 1 个无影', a0.shadow === 'none', a0.shadow)
  ok(tag + '初始第 3 个激活且有影', a1.isOn && a1.shadow !== 'none',
     a1.isOn ? a1.shadow.slice(0, 44) : '不是激活态')

  /* B. 悬停 */
  await moveTo(a0.x, a0.y)
  const b0 = await tabInfo(card.p, 0)
  ok(tag + '悬停出阴影', b0.shadow !== 'none', b0.shadow.slice(0, 54))
  if (card.lift) {
    ok(tag + '悬停上浮 1px', Math.abs(b0.ty + 1) < 0.01, b0.ty + 'px')
  } else {
    ok(tag + '悬停不位移（静）', b0.ty === 0, b0.ty + 'px')
  }

  /* C. 移开 */
  await moveTo(5, 5)
  const c0 = await tabInfo(card.p, 0)
  ok(tag + '移开影子归零', c0.shadow === 'none', c0.shadow)
  ok(tag + '移开位移归零', c0.ty === 0, c0.ty + 'px')

  /* D. 按下 */
  const d0 = await tabInfo(card.p, 0)
  await moveTo(d0.x, d0.y)
  await pressAt(d0.x, d0.y)
  const dActive = await tabInfo(card.p, 0)
  await releaseAt(d0.x, d0.y)
  if (card.lift) {
    ok(tag + '按下压回原位', Math.abs(dActive.ty) < 0.01, dActive.ty + 'px')
  } else {
    ok(tag + '按下影子收干净', dActive.shadow === 'none', dActive.shadow.slice(0, 40))
  }

  /* E. 点击第 2 个 → 激活态转移 */
  const e0 = await tabInfo(card.p, 1)
  await moveTo(e0.x, e0.y)
  await pressAt(e0.x, e0.y)
  await releaseAt(e0.x, e0.y)
  const eNew = await tabInfo(card.p, 1)
  const eOld = await tabInfo(card.p, 2)
  ok(tag + '点击后第 2 个成激活态', eNew.isOn, eNew.isOn ? 'on' : '未变')
  ok(tag + '原激活态被取消', !eOld.isOn, eOld.isOn ? '仍是 on' : 'off')
  ok(tag + '激活态有常驻阴影', eNew.shadow !== 'none', eNew.shadow.slice(0, 46))
}

/* F. 光标：只有可操作卡是手型 */
const cursorProbe = await ev(`
(() => {
  const pick = (p) => getComputedStyle(document.querySelector('.plan[data-p="' + p + '"] .tab')).cursor;
  return { p1: pick(1), p3: pick(3), p9: pick(9) };
})()
`)
ok('01 页签是手型光标', cursorProbe.p1 === 'pointer', cursorProbe.p1)
ok('09 页签是手型光标', cursorProbe.p9 === 'pointer', cursorProbe.p9)
ok('静态方案 03 保持默认光标', cursorProbe.p3 !== 'pointer', cursorProbe.p3)

let fails = 0
for (const c of out) {
  console.log(`${c.pass ? '✔' : '✘'} ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`)
  if (!c.pass) fails++
}
if (errors.length) {
  console.log('\nJS 异常:')
  errors.forEach((e) => console.log('  ' + e.split('\n')[0]))
  fails += errors.length
}
console.log(`\n${fails === 0 ? '✅ 全部通过' : '❌ ' + fails + ' 项未通过'}（共 ${out.length} 项断言）`)
chrome.kill()
process.exit(fails === 0 ? 0 : 1)
