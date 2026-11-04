/**
 * 最小 e2e 冒烟 · 6 条（CDP / DOM，不截图）
 *
 * 自包含：启动 vite --mode web（渲染层走 mock 数据）→ 无头 Chrome → CDP 读
 * DOM / 计算样式 / 控制台文本 → 全部结束后自动清理进程。
 * 零新增依赖：用 Node 内置 WebSocket 与 child_process。
 *
 * 用法：
 *   npm run test:e2e
 *   CHROME_PATH=/usr/bin/google-chrome npm run test:e2e   # CI
 *
 * 六条：启动 / mock 连接 / 六类值渲染 / 切标签隔离 / 删除确认 / 主题切换。
 * 按项目红线不使用任何截图，几何数值只以文本输出。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 5242)
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9242)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------ Chrome 探测 */

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ]
  const pw = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')
  if (fs.existsSync(pw)) {
    const versions = fs.readdirSync(pw).filter((d) => d.startsWith('chromium-')).sort().reverse()
    for (const v of versions) candidates.push(path.join(pw, v, 'chrome-win64', 'chrome.exe'))
  }
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

const CHROME = findChrome()
if (!CHROME) {
  console.error('✘ 找不到 Chrome/Chromium。请设置 CHROME_PATH 指向可执行文件。')
  process.exit(1)
}

/* ------------------------------------------------------------- 进程启动 */

const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const vite = spawn(process.execPath, [viteBin, '--mode', 'web', '--port', String(WEB_PORT), '--strictPort'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
})
let viteErr = ''
vite.stderr?.on('data', (d) => { viteErr = (viteErr + d.toString()).slice(-1200) })

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyper-e2e-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userDataDir}`, '--no-first-run', '--disable-gpu',
  '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' })

const cleanup = () => {
  try { chrome.kill() } catch { /* 已退出 */ }
  try { vite.kill() } catch { /* 已退出 */ }
}
process.on('exit', cleanup)

async function waitFor(url, tries, label) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch { /* 未就绪 */ }
    await sleep(300)
  }
  console.error(`✘ ${label} 未就绪：${url}`)
  return false
}

if (!await waitFor(`http://127.0.0.1:${WEB_PORT}/`, 100, 'vite web')) {
  console.error(viteErr); cleanup(); process.exit(1)
}
if (!await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, 60, 'CDP')) {
  cleanup(); process.exit(1)
}
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) { console.error('✘ CDP 没有可用页面'); cleanup(); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let seq = 0
const pending = new Map()
const jsErrors = []
const consoleErrors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') {
    jsErrors.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 160))
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    const en = m.params.entry
    /* vite dev 没有 favicon，这个 404 与业务无关 */
    if (!/favicon\.ico/.test(en.url || '') && !/favicon\.ico/.test(en.text || '')) {
      consoleErrors.push((en.text || '').slice(0, 160))
    }
  }
}
const send = (method, params = {}) => new Promise((r) => {
  const id = ++seq; pending.set(id, r)
  ws.send(JSON.stringify({ id, method, params }))
})
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) {
    throw new Error(String(r.result.exceptionDetails.exception?.description || '').slice(0, 300))
  }
  return r.result?.result?.value
}
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable')

async function waitMounted() {
  for (let i = 0; i < 100; i++) {
    if (await ev(`document.getElementById('root')?.children.length || 0`)) return true
    await sleep(400)
  }
  return false
}
await send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` })
const mounted = await waitMounted()
await sleep(1000)

/* ---------------------------------------------------------------- 断言 */

const results = []
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) })

/* 1. 启动 */
const boot = await ev(`(() => ({
  ready: document.readyState,
  app: !!document.querySelector('.s-app'),
  kids: document.getElementById('root')?.children.length || 0,
}))()`)
check('启动：首屏挂载且 readyState=complete',
  mounted && boot.ready === 'complete' && boot.app && boot.kids > 0,
  `ready=${boot.ready} app=${boot.app} kids=${boot.kids}`)
check('启动：无 JS 异常与非 favicon 控制台错误',
  jsErrors.length === 0 && consoleErrors.length === 0,
  `异常=${jsErrors.length} 控制台=${consoleErrors.length}${consoleErrors[0] ? ' ' + consoleErrors[0] : ''}`)

/* 2. mock 连接（两引擎混排） */
const conns = await ev(`(() => [...document.querySelectorAll('.conn-item')].map(e => e.textContent.trim()))()`)
const connText = (conns || []).join('|')
check('mock 连接：6 个连接项', (conns || []).length === 6, (conns || []).length + ' 个')
check('mock 连接：Redis 与 Memcached 两引擎均在列表中',
  /本地开发/.test(connText) && /本地缓存/.test(connText),
  (conns || []).slice(0, 3).map((s) => s.slice(0, 12)).join(' / '))

/* 3. 六类值渲染 */
await ev(`(() => { document.querySelector('.conn-item')?.click(); return true })()`)
await sleep(2600)
await ev(`(() => { const b = [...document.querySelectorAll('.view-switch button')][1]; if (b) { b.click(); return true } return false })()`)
await sleep(1700)
const keyState = await ev(`(() => ({
  /* 所有标签常驻挂载，隐藏工作区的 .key-item 仍在 DOM 里，必须按可见过滤 */
  count: [...document.querySelectorAll('.key-item')].filter(e => e.offsetParent !== null).length,
  types: [...new Set([...document.querySelectorAll('.key-item .type-badge')].map(e => e.className).map(c => (c.match(/type-(hash|string|list|set|zset|stream)/) || [])[1]).filter(Boolean))].sort(),
}))()`)
const WANTED = ['hash', 'list', 'set', 'stream', 'string', 'zset']
check('六类值：平铺视图键列表覆盖六种类型',
  keyState.count > 0 && WANTED.every((t) => keyState.types.includes(t)),
  `${keyState.count} 键 / ${keyState.types.join(',')}`)
await ev(`(() => { document.querySelector('.key-item')?.click(); return true })()`)
await sleep(1500)
const value = await ev(`(() => ({
  keyName: document.querySelector('.s-value-viewer .key-name')?.textContent?.trim() || '',
  typeText: document.querySelector('.s-value-viewer .type-badge')?.textContent?.trim() || '',
  hasFields: document.querySelectorAll('.s-value-viewer table, .s-value-viewer [class*=table]').length > 0,
}))()`)
check('六类值：点击键后值区渲染键名与类型',
  value.keyName.length > 0 && value.typeText.length > 0,
  `key=${value.keyName} type=${value.typeText}`)

/* 4. 切标签隔离 */
await ev(`(() => { const items = document.querySelectorAll('.conn-item'); items[1]?.click(); return true })()`)
await sleep(2300)
const twoTabs = await ev(`(() => ({
  tabs: [...document.querySelectorAll('.tab')].map(e => e.textContent.trim()),
  active: document.querySelector('.tab.active')?.textContent.trim() || '',
}))()`)
check('切标签：打开第二个连接后页签增至 3 个',
  twoTabs.tabs.length === 3, twoTabs.tabs.join(' / '))
await ev(`(() => { const t = [...document.querySelectorAll('.tab')].find(x => /本地开发/.test(x.textContent)); if (t) { t.click(); return true } return false })()`)
await sleep(1600)
const back = await ev(`(() => ({
  active: document.querySelector('.tab.active')?.textContent.trim() || '',
  /* 同上：切回后隐藏实例必须排除，才能验证「保活且状态保持」 */
  keys: [...document.querySelectorAll('.key-item')].filter(e => e.offsetParent !== null).length,
}))()`)
check('切标签：切回后 active 恢复且可见键列表保持（会话隔离/保活）',
  /本地开发/.test(back.active) && back.keys === keyState.count,
  `active=${back.active} keys=${back.keys}（原 ${keyState.count}）`)

/* 5. 删除确认（只验弹窗，不实际删除） */
await ev(`(() => { const b = document.querySelector('.del-btn'); if (b) { b.click(); return true } return false })()`)
await sleep(900)
const confirm = await ev(`(() => ({
  open: !!document.querySelector('.confirm-dialog') || !!document.querySelector('.dlg-shell'),
  text: (document.querySelector('.confirm-dialog') || document.querySelector('.dlg-shell'))?.innerText?.slice(0, 90) || '',
}))()`)
check('删除确认：破坏性操作弹出二次确认', confirm.open, confirm.text.replace(/\s+/g, ' ').slice(0, 60))
await ev(`(() => {
  const b = [...document.querySelectorAll('.confirm-dialog button, .dlg-shell button')]
    .find(x => /取消|cancel/i.test(x.textContent || ''));
  if (b) { b.click(); return true } return false
})()`)
await sleep(700)
const closed = await ev(`!document.querySelector('.confirm-dialog') && !document.querySelector('.dlg-shell')`)
check('删除确认：可取消、不执行删除', closed)

/* 6. 主题切换 */
const beforeAccent = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`)
await ev(`(() => { localStorage.setItem('keyper:theme', 'ocean'); return true })()`)
await send('Page.reload', { ignoreCache: false })
await waitMounted()
await sleep(900)
const theme = await ev(`(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  scheme: document.documentElement.style.colorScheme,
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
}))()`)
check('主题切换：ocean 皮肤首帧生效且强调色随主题变化',
  theme.theme === 'ocean' && theme.scheme === 'dark' && theme.accent !== beforeAccent && theme.accent.length > 0,
  `theme=${theme.theme} scheme=${theme.scheme} accent=${beforeAccent} → ${theme.accent}`)

/* ---------------------------------------------------------------- 汇总 */

let fails = 0
for (const c of results) {
  console.log(`${c.pass ? '✔' : '✘'} ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`)
  if (!c.pass) fails++
}
if (jsErrors.length) console.log('JS 异常:', jsErrors.slice(0, 3).join(' | '))
if (consoleErrors.length) console.log('控制台错误:', consoleErrors.slice(0, 3).join(' | '))
console.log(`\n${fails === 0 ? '✅ e2e 冒烟全部通过' : '❌ ' + fails + ' 条未通过'}（共 ${results.length} 条断言，未使用截图）`)
ws.close()
cleanup()
process.exit(fails === 0 ? 0 : 1)
