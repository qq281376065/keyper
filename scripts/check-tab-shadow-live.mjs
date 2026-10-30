/**
 * 连接页签阴影（方案「静浮」）· 真实渲染探针
 *
 * 落地后要验的三件事，都不是「看一眼」能确定的：
 *
 *   A. 四级层级是否真的成立
 *      默认 none → hover 单层 → 激活双层 → 按下 none
 *      其中 hover / 按下必须用 CDP 真实鼠标事件，读静态样式测不出来。
 *
 *   B. 阴影会不会被裁
 *      .tab 上下各 4px 余量（页签栏 33px、胶囊 25px），而 .tab-strip 是
 *      overflow-x:auto —— 按规范 overflow-y 随之变 auto，超出的阴影会被裁。
 *      这里直接量「页签底边 + 4px 是否 ≤ 滚动容器底边」。
 *
 *   C. 是否随皮肤换色
 *      --shadow-ink 浅底是带色相的深色、暗底是纯黑；切主题后等过渡结束再读，
 *      否则拿到的是过渡起点的旧颜色（这个坑踩过一次）。
 *
 * 不截图。用法：node scripts/check-tab-shadow-live.mjs（需 dev:web 在 5230）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const URL = 'http://127.0.0.1:5230/'
const CHROME = 'C:/Users/admin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const PORT = 9454

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + fs.mkdtempSync('C:/Users/admin/AppData/Local/Temp/cdp-tabshadow-'),
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

/* ---------------- 先开一个连接，凑出第二个页签 ---------------- */
await ev(`document.querySelector('.conn-item')?.click()`)
await new Promise((r) => setTimeout(r, 2600))

const tabsInfo = () => ev(`
(() => {
  const bar = document.querySelector('.tabbar');
  const strip = bar.querySelector('.tab-strip');
  const tabs = [...bar.querySelectorAll('.tab')];
  return {
    count: tabs.length,
    stripBottom: strip ? Math.round(strip.getBoundingClientRect().bottom) : null,
    tabs: tabs.map((t) => {
      const r = t.getBoundingClientRect();
      const cs = getComputedStyle(t);
      return {
        cls: t.className,
        text: t.textContent.trim().slice(0, 10),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        bottom: Math.round(r.bottom),
        h: Math.round(r.height),
        shadow: cs.boxShadow,
        isActive: t.classList.contains('active'),
      };
    }),
  };
})()`)

const t0 = await tabsInfo()
ok('页签栏已渲染', t0.count >= 1, t0.count + ' 个页签')
ok('打开连接后有两个页签', t0.count >= 2, t0.count + ' 个')
if (t0.count < 2) {
  console.log('✘ 只有主页一个页签，无法测 hover（连接可能没开成功）')
  chrome.kill()
  process.exit(1)
}

const layerCount = (shadow) => (shadow.match(/rgba?\(/g) || []).length
const activeTab = t0.tabs.find((t) => t.isActive)
const idleTab = t0.tabs.find((t) => !t.isActive)
ok('存在激活页签', !!activeTab, activeTab?.text ?? 'none')
ok('激活页签有双层阴影', layerCount(activeTab.shadow) === 2,
   activeTab.shadow.slice(0, 70))
ok('默认页签无阴影', idleTab.shadow === 'none', idleTab.shadow)
/* 用户明确要求「仅仅是阴影效果，不是连接项选中状态的特效」——磁贴选中带
   inset 1px 品牌色描边，页签不该有 */
ok('选中态只借阴影、不带 inset 描边', !activeTab.shadow.includes('inset'), activeTab.shadow.includes('inset') ? '有 inset' : '无 inset')

/* ---------------- B. 几何：阴影不出滚动容器 ---------------- */
const slack = Math.min(...t0.tabs.map((t) => t0.stripBottom - t.bottom))
ok('页签下方留白 ≥ 4px（阴影不被裁）', slack >= 4, '最小 ' + slack + 'px（页签高 ' + t0.tabs[0].h + 'px）')

/* ---------------- A. hover：真实鼠标 ---------------- */
const moveTo = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await new Promise((r) => setTimeout(r, 260))
}

await moveTo(idleTab.x, idleTab.y)
const hovered = (await tabsInfo()).tabs.find((t) => t.text === idleTab.text)
ok('hover 出分层双影（与连接磁贴同档）', layerCount(hovered.shadow) === 2,
   hovered.shadow.slice(0, 70))

await moveTo(5, 5)
const afterLeave = (await tabsInfo()).tabs.find((t) => t.text === idleTab.text)
ok('移开后阴影消失', afterLeave.shadow === 'none', afterLeave.shadow)

/* 激活态 hover：与常态用同一层（磁贴也是 hover / 选中同一层），不该再加深 */
await moveTo(activeTab.x, activeTab.y)
const activeHover = (await tabsInfo()).tabs.find((t) => t.isActive)
ok('激活态 hover 仍是双层', layerCount(activeHover.shadow) === 2, activeHover.shadow.slice(0, 70))
ok('激活态 hover 与常态同层（不额外加深）', activeHover.shadow === activeTab.shadow,
   activeHover.shadow === activeTab.shadow ? '一致' : activeTab.shadow.slice(0, 50) + ' → ' + activeHover.shadow.slice(0, 50))

/* 按下：影子收干净 */
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: idleTab.x, y: idleTab.y, button: 'left', clickCount: 1, buttons: 1 })
await new Promise((r) => setTimeout(r, 220))
const pressed = (await tabsInfo()).tabs.find((t) => t.text === idleTab.text)
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: idleTab.x, y: idleTab.y, button: 'left', clickCount: 1, buttons: 0 })
await new Promise((r) => setTimeout(r, 400))
ok('按下时阴影收干净', pressed.shadow === 'none', pressed.shadow)

/* 点击后激活态转移 */
const afterClick = await tabsInfo()
const newActive = afterClick.tabs.find((t) => t.isActive)
ok('点击后激活态转移到被点的页签', newActive?.text === idleTab.text, newActive?.text ?? 'none')
ok('新激活页签带阴影', newActive.shadow !== 'none', newActive.shadow.slice(0, 60))

/* ---------------- C. 阴影随皮肤换色 ----------------
 * 先把鼠标挪开：停在页签上会进入 .active:hover（比常态深一档），
 * 拿那个值算「看不看得见」会偏乐观、也漏掉常态偏弱的情况。
 */
await moveTo(5, 5)


const skinProbe = await ev(`
(async () => {
  const wait = () => new Promise((r) => setTimeout(r, 320));
  const pick = () => {
    const el = document.querySelector('.tabbar .tab.active');
    return el ? getComputedStyle(el).boxShadow : 'none';
  };
  const inkOf = () => getComputedStyle(document.documentElement).getPropertyValue('--shadow-ink').trim();
  const panelOf = () => getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim();
  const themes = ['light', 'dark', 'ocean', 'solarized', 'forest', 'sakura', 'mint', 'mist', 'aurora'];
  const rows = [];
  for (const th of themes) {
    document.documentElement.dataset.theme = th;
    await wait();
    rows.push({ th, shadow: pick(), ink: inkOf(), panel: panelOf() });
  }
  document.documentElement.dataset.theme = 'light';
  await wait();
  return rows;
})()
`)

if (!Array.isArray(skinProbe)) {
  ok('九套皮肤阴影取样', false, JSON.stringify(skinProbe).slice(0, 160))
} else {
  ok('九套皮肤都拿到阴影', skinProbe.every((r) => r.shadow !== 'none'), skinProbe.filter((r) => r.shadow === 'none').map((r) => r.th).join(',') || 'ok')
  const light = skinProbe.find((r) => r.th === 'light')
  const dark = skinProbe.find((r) => r.th === 'dark')
  const sol = skinProbe.find((r) => r.th === 'solarized')
  ok('浅色墨 ≠ 暗色墨', light.ink !== dark.ink, `${light.ink} vs ${dark.ink}`)
  /* 页签要跟连接磁贴同色，所以亮色组不再各用各的带色相墨，统一成磁贴那支冷灰蓝 */
  ok('亮色组统一冷灰蓝（与磁贴同色）', sol.ink === '15 23 42', sol.ink)
  ok('阴影随主题真的换色', light.shadow !== dark.shadow, light.shadow.slice(0, 40) + ' ≠ ' + dark.shadow.slice(0, 40))

  /*
   * 最容易被忽略、也最容易回归的一条：阴影在各自的底色上到底看不看得见。
   * 暗色底黑压黑，同一档 alpha 只剩 5 个通道差 —— 所以这里不看 alpha 大小，
   * 而是把墨色按该层 alpha 合成到 --bg-panel 上，量真实亮度差。
   * 阈值 10：低于这个数，肉眼基本分不出「有影子」。
   */
  const rgbOf = (str) => {
    const v = String(str).trim()
    if (v.startsWith('#')) {
      const t = v.slice(1)
      const n = t.length === 3 ? t.split('').map((c) => c + c).join('') : t
      return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)]
    }
    const m = v.match(/(\d+)/g)
    return m ? [+m[0], +m[1], +m[2]] : null
  }
  const worst = skinProbe
    .map((r) => {
      const alphas = [...r.shadow.matchAll(/rgba?\([^)]*?([\d.]+)\)/g)].map((m) => +m[1])
      const a = alphas.length >= 2 ? alphas[1] : alphas[0]
      const ink = r.ink.split(/\s+/).map(Number)
      const panel = rgbOf(r.panel)
      const mixed = ink.map((v, i) => Math.round(v * a + panel[i] * (1 - a)))
      const diff = Math.max(...mixed.map((v, i) => Math.abs(v - panel[i])))
      return { th: r.th, diff, a }
    })
    .sort((x, y) => x.diff - y.diff)

  ok('每套皮肤阴影在其底色上都看得见（通道差 ≥ 10）', worst[0].diff >= 10,
     `最弱 ${worst[0].th}：${worst[0].diff}（alpha ${worst[0].a}）`)
  ok('暗色三套都达标', ['dark', 'ocean', 'forest'].every((th) => worst.find((w) => w.th === th).diff >= 10),
     ['dark', 'ocean', 'forest'].map((th) => th + ':' + worst.find((w) => w.th === th).diff).join(' '))
}

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
