/**
 * CSP 运行时探针（Electron 45+ 升级验证 / 只读，不截图）
 *
 * 用途：每级 Electron 升级后，用生产构建产物起真机窗口，验证
 *   1) file:// 主文档不带 Content-Security-Policy 响应头（由 meta 单独约束）
 *   2) 控制台 security 错误为 0（含 D2 的 style-src 偶发观察项）
 *   3) meta CSP 指令完整、hash 正确、首帧主题脚本确实执行
 *   4) theme / redisApi / --accent / --lift-shadow 等运行时令牌正常
 *
 * 用法：
 *   1. unset ELECTRON_RUN_AS_NODE
 *      ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9235
 *   2. node scripts/check-csp-runtime.mjs [端口，默认 9235]
 *
 * 注意：scripts/* 被 .gitignore 整体忽略；要入库需 git add -f 本文件。
 */
const PORT = Number(process.argv[2] || 9235)
const LIST = `http://127.0.0.1:${PORT}/json/list`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let targets = null
for (let i = 0; i < 40; i++) {
  try {
    const l = await (await fetch(LIST)).json()
    if (l.some((x) => x.type === 'page')) { targets = l; break }
  } catch { /* 未就绪 */ }
  await sleep(500)
}
if (!targets) { console.log('CDP 未就绪'); process.exit(1) }
const page = targets.find((x) => x.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let id = 0
const pending = new Map()
let docs = []
let errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Network.responseReceived') {
    const p = m.params
    if (p.type === 'Document' || (p.response.url || '').endsWith('.html')) {
      docs.push({
        url: p.response.url,
        status: p.response.status,
        csp: p.response.headers?.['Content-Security-Policy']
          ?? p.response.headers?.['content-security-policy'] ?? null,
      })
    }
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    const en = m.params.entry
    errors.push({ source: en.source, url: en.url, line: en.lineNumber, text: (en.text || '').slice(0, 200) })
  }
}
const send = (method, params = {}) => new Promise((r) => {
  const i = ++id; pending.set(i, r)
  ws.send(JSON.stringify({ id: i, method, params }))
})
await send('Network.enable')
await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')

const kind = (t) => {
  if (/inline script|script-src|Refused to execute/i.test(t)) return 'script-csp'
  if (/inline style|style-src/i.test(t)) return 'style-csp'
  if (/Content Security Policy|Refused to/i.test(t)) return 'other-csp'
  return 'non-csp'
}

const rounds = []
for (let round = 1; round <= 2; round++) {
  docs = []; errors = []
  await send('Page.reload', { ignoreCache: true })
  await sleep(3500)
  const cspErr = errors.filter((e) => kind(e.text) !== 'non-csp')
  rounds.push({ round, docs: [...docs], errors: [...errors], cspErr })
  console.log(`\n=== 第 ${round} 轮 ===`)
  console.log('主文档响应:', JSON.stringify(docs, null, 2))
  console.log('控制台 error 总数:', errors.length, '| CSP 相关:', cspErr.length,
    '| style-src:', errors.filter((e) => kind(e.text) === 'style-csp').length)
  errors.slice(0, 6).forEach((e, i) => console.log(`  [${i + 1}] (${kind(e.text)}) ${e.source} ${e.url || ''}:${e.line || ''} ${e.text}`))
}

const expr = `(() => {
  const cs = getComputedStyle(document.documentElement)
  const meta = Array.from(document.querySelectorAll('meta')).find(
    (m) => (m.httpEquiv || '').toLowerCase() === 'content-security-policy')
  const api = window.redisApi || {}
  const dirs = (meta?.content || '').split(';').map((s) => s.trim()).filter(Boolean)
  return {
    title: document.title,
    readyState: document.readyState,
    hasApp: !!document.querySelector('.s-app'),
    theme: document.documentElement.getAttribute('data-theme'),
    htmlStyle: document.documentElement.getAttribute('style'),
    apiGroups: Object.keys(api).length,
    apiHasLua: !!api.luaScripts,
    accent: cs.getPropertyValue('--accent').trim(),
    liftShadow: cs.getPropertyValue('--lift-shadow').trim().slice(0, 90),
    metaPresent: !!meta,
    directives: dirs,
    styleTags: document.querySelectorAll('style').length,
    styleAttrs: document.querySelectorAll('[style]').length,
    externalScripts: Array.from(document.scripts).filter((s) => s.src).map((s) => s.src.replace(/^file:\\/\\/\\//, 'file:///')),
    stylesheets: Array.from(document.querySelectorAll('link[rel=stylesheet]')).map((l) => l.getAttribute('href')),
  }
})()`
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
const d = r.result?.result?.value ?? r.result
console.log('\n=== DOM / 运行时状态 ===')
console.log(JSON.stringify(d, null, 2))

const expected = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'",
  "img-src 'self' data:", "connect-src 'self'", "base-uri 'none'", "form-action 'none'",
  "object-src 'none'", "frame-src 'none'", "worker-src 'none'"]
const missing = expected.filter((x) => !d.directives.some((y) => y.startsWith(x)))
const allCspErr = rounds.flatMap((x) => x.cspErr)
const noHeader = rounds.every((x) => x.docs.length > 0 && x.docs.every((y) => y.csp === null))
const styleErrors = rounds.map((x) => x.errors.filter((e) => kind(e.text) === 'style-csp').length)
console.log('\n=== 判定 ===')
console.log('主文档无 CSP 响应头      :', noHeader ? 'PASS' : 'FAIL')
console.log('security 错误 0          :', allCspErr.length === 0 ? 'PASS' : `FAIL (${allCspErr.length})`)
console.log('meta 指令完整            :', missing.length === 0 ? 'PASS' : `FAIL 缺 ${missing.join(', ')}`)
console.log('meta 含正确脚本 hash     :', d.directives.some((x) => x.includes('sha256-duieBjFDc0BF0OuaVKTeTRRVJ7um0TpmK9X9RaugcaM=')) ? 'PASS' : 'FAIL')
console.log('主题 / API / 阴影令牌    :', (d.theme && d.apiGroups > 0 && d.accent && d.liftShadow) ? 'PASS' : 'FAIL')
console.log('首帧脚本痕迹 (colorScheme):', /color-scheme/i.test(d.htmlStyle || '') ? '有' : '无')
console.log('D2 style-src 观察(两轮)  :', styleErrors.join(' / '), '（观察项，不判定）')
ws.close()

const pass = noHeader && allCspErr.length === 0 && missing.length === 0 && !!d.theme && d.apiGroups > 0
process.exit(pass ? 0 : 1)
