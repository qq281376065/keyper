/**
 * 浮起阴影 · DB 工具条选中态探针
 *
 * 覆盖 L1 / L2 / 全部展开 / 全部折叠 / 批量选择 这五个 .mini 按钮：
 * 选中时在原有的 inset 1px 品牌色描边之外，再叠一层 --lift-shadow
 * （与页签、连接磁贴同一套「分层双影」压缩版）。
 *
 * 为什么要单独测：
 *   A. 五个按钮共用 .mini.on 一条规则，但只有 L1/L2 在树形视图下存在，
 *      批量按钮在平铺视图也有 —— 实际渲染的按钮数量随视图变，容易顾此失彼
 *   B. 选中态必须**两个都在**：inset 描边（原有标识）+ 外层阴影（新增）。
 *      只加外层会丢描边，只用 inset 则没变化 —— 两者都要断言
 *   C. 按钮只 20px 高、工具条上下 5px padding，阴影净可见 4px 必须落在余量内
 *
 * 不截图。用法：node scripts/check-lift-shadow.mjs（需 dev:web 在 5230）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const URL = 'http://127.0.0.1:5230/'
const CHROME = 'C:/Users/admin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const PORT = 9462

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + fs.mkdtempSync('C:/Users/admin/AppData/Local/Temp/cdp-lift2-'),
  '--no-first-run', '--disable-gpu', '--no-proxy-server',
  '--window-size=1500,950', 'about:blank',
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
await new Promise((r) => setTimeout(r, 5200))

const out = []
const ok = (name, cond, detail) => out.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) })
const layerCount = (shadow) => (shadow.match(/rgba?\(/g) || []).length
const outerLayers = (shadow) => layerCount(shadow.split('inset').join('')) // 粗略：去掉 inset 字样后数颜色

/* 进连接，切树形视图（L1/L2 只在树形下存在） */
await ev(`document.querySelector('.conn-item')?.click()`)
await new Promise((r) => setTimeout(r, 3200))
await ev(`
(() => {
  const btn = [...document.querySelectorAll('.view-switch button, .viewbar button')]
    .find((b) => b.textContent.trim() === '树形');
  if (btn) btn.click();
  return !!btn;
})()`)
await new Promise((r) => setTimeout(r, 900))

const readMinis = () => ev(`
(() => [...document.querySelectorAll('.viewbar .mini')].map((b, i) => {
  const cs = getComputedStyle(b);
  const r = b.getBoundingClientRect();
  const bar = b.closest('.viewbar').getBoundingClientRect();
  return {
    i,
    label: b.textContent.trim() || 'icon',
    on: b.classList.contains('on'),
    shadow: cs.boxShadow,
    inset: cs.boxShadow.includes('inset'),
    h: Math.round(r.height),
    bottomToBar: Math.round(bar.bottom - r.bottom),
  };
}))()`)

const before = await readMinis()
if (!Array.isArray(before)) {
  console.log('✘ 拿不到 .viewbar .mini', JSON.stringify(before).slice(0, 200))
  chrome.kill(); process.exit(1)
}

ok('工具条有 5 个 mini 按钮', before.length === 5, before.length)
ok('L1 / L2 文本按钮存在', before.filter((b) => b.label === 'L1' || b.label === 'L2').length === 2,
   before.map((b) => b.label).join(','))

/* 点 L1 → 该按钮 on、带 inset + 外层阴影 */
const clickMini = async (label) => {
  await ev(`
(() => {
  const b = [...document.querySelectorAll('.viewbar .mini')]
    .find((x) => ${label ? `x.textContent.trim() === ${JSON.stringify(label)}` : '!x.textContent.trim() && !x.classList.contains(\'on\')'});
  if (b) b.click();
  return !!b;
})()`)
  await new Promise((r) => setTimeout(r, 700))
}

await clickMini('L1')
const afterL1 = await readMinis()
const l1 = afterL1.find((b) => b.label === 'L1')
ok('点 L1 后进入选中态', l1.on, l1.on ? 'on' : 'off')
ok('L1 保留 inset 描边（原有标识）', l1.inset, l1.inset ? '有' : '无')
ok('L1 叠了外层浮起阴影', layerCount(l1.shadow) === 3, layerCount(l1.shadow) + ' 层（1 inset + 2 外影）')
ok('L1 外层两层：近影 1px + 远影 2px',
   /\s0px 1px 1px/.test(l1.shadow) && /\s0px 2px 3px -1px/.test(l1.shadow), l1.shadow.slice(0, 80))

/* 阴影落在工具条余量内（按钮 20px + 上下 5px padding） */
ok('阴影在工具条余量内（下沿留白 ≥ 4px）', l1.bottomToBar >= 4, l1.bottomToBar + 'px（按钮高 ' + l1.h + '）')

/* 未选中的按钮不带外层阴影 */
const idle = afterL1.filter((b) => !b.on)
ok('未选中按钮无阴影', idle.every((b) => b.shadow === 'none'),
   idle.filter((b) => b.shadow !== 'none').map((b) => b.label).join(',') || 'ok')

/* 切到 L2：L1 应该退选、L2 选中 */
await clickMini('L2')
const afterL2 = await readMinis()
const l2 = afterL2.find((b) => b.label === 'L2')
const l1Again = afterL2.find((b) => b.label === 'L1')
ok('点 L2 后 L2 选中', l2.on, l2.on ? 'on' : 'off')
ok('L1 同时退选（互斥）', !l1Again.on, l1Again.on ? '仍 on' : 'off')
ok('L2 也有外层阴影', layerCount(l2.shadow) === 3, layerCount(l2.shadow) + ' 层')

/* 批量按钮：图标按钮，点它进入勾选模式 */
await clickMini(null)
const afterBulk = await readMinis()
const bulk = afterBulk.find((b) => b.on && !['L1', 'L2'].includes(b.label))
ok('批量按钮可进入选中态', !!bulk, bulk ? '有' : '无')
if (bulk) {
  ok('批量按钮也带 inset + 外影', bulk.inset && layerCount(bulk.shadow) === 3,
     bulk.inset ? layerCount(bulk.shadow) + ' 层' : '缺 inset')
}

/* 与页签同源：两处的外层阴影（去掉 inset 层后）必须逐字一致 */
const same = await ev(`
(() => {
  const tab = document.querySelector('.tabbar .tab.active');
  const mini = document.querySelector('.viewbar .mini.on');
  if (!tab || !mini) return null;
  /* 按「层」拆：只在括号外的逗号处切，然后丢掉带 inset 的那层 */
  const outer = (s) => s.split(/,(?![^(]*\\))/).map((x) => x.trim()).filter((x) => !x.includes('inset')).join(', ');
  const a = outer(getComputedStyle(tab).boxShadow);
  const b = outer(getComputedStyle(mini).boxShadow);
  return { tab: a, mini: b, sameOuter: a === b };
})()
`)
ok('页签与工具条按钮的外层阴影完全同源', same && same.sameOuter,
   same ? (same.sameOuter ? '一致' : same.tab.slice(0, 40) + ' vs ' + same.mini.slice(0, 40)) : '取不到')


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
