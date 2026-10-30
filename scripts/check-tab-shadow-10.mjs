/**
 * 连接页签阴影 10 套 · 探针
 *
 * 这轮的关键风险不是「不好看」，是「阴影被裁」：
 *   .tab 高 28px、页签栏 36px → 上下各只有 4px 余量，
 *   阴影「y 偏移 + 模糊 − 收缩」超过 4px 的部分在真实项目里看不到
 *   （真实 .tab-strip 是 overflow-x:auto，纵向也会被裁）。
 *
 * 断言四组：
 *   A. 结构：10 套 × 4 个页签；激活 1 个、hover 演示 1 个
 *   B. 不重复：10 套激活态 box-shadow 两两不同
 *   C. 不溢出：外阴影净可见 ≤ 4px；inset 阴影不产生外溢
 *   D. 随皮肤：同一套在浅/深皮肤下阴影色不同（--ink 生效）
 *
 * 不截图。用法：node scripts/check-tab-shadow-10.mjs（需 5320 端口服务）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const URL = 'http://127.0.0.1:5320/tab-shadow-10.html'
const CHROME = 'C:/Users/admin/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const PORT = 9450

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + fs.mkdtempSync('C:/Users/admin/AppData/Local/Temp/cdp-ts-'),
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
  if (r.result?.exceptionDetails) {
    return { __err: (r.result.exceptionDetails.exception?.description || '').slice(0, 300) }
  }
  return r.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: URL })
await new Promise((r) => setTimeout(r, 1600))

const probe = `
(() => {
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? '' : String(d) });

  /* 解析 computed box-shadow：拆成层，每层取 [inset?, x, y, blur, spread, color] */
  const parseShadow = (s) => {
    if (!s || s === 'none') return [];
    const layers = [];
    let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { layers.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) layers.push(cur.trim());
    return layers.map((L) => {
      const inset = /inset/.test(L);
      const nums = [...L.matchAll(/(-?[\\d.]+)px/g)].map((m) => parseFloat(m[1]));
      const color = (L.match(/(rgba?\\([^)]*\\)|#[0-9a-f]{3,8})/i) || [null])[0];
      /* 有 inset 时数值仍是 x y blur spread */
      return { inset, x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, spread: nums[3] ?? 0, color, raw: L };
    });
  };

  const plans = [...document.querySelectorAll('.plan')];
  ok('十套方案', plans.length === 10, plans.length);
  ok('皮肤切换 9 个', document.querySelectorAll('.switch .sw').length === 9, document.querySelectorAll('.switch .sw').length);

  const shadows = [];
  let maxReach = 0, maxReachNo = '';

  plans.forEach((p) => {
    const no = p.querySelector('.pno').textContent.trim();
    const tabs = [...p.querySelectorAll('.tbar .tab')];
    ok(no + ' 四个页签', tabs.length === 4, tabs.length);
    ok(no + ' 激活 1 个', tabs.filter((t) => t.classList.contains('on')).length === 1);
    /* 09 是可操作的那一套：不放静态 .hv（真实 hover 由 check-tab-lift 验），
       其余九套仍用一个 .hv 页签静态演示悬停态 */
    const interactive = !!p.querySelector('.try')
    const hvCount = tabs.filter((t) => t.classList.contains('hv')).length
    ok(no + ' hover 演示页签', interactive ? hvCount === 0 : hvCount === 1,
       interactive ? '可操作方案，无静态 hv' : hvCount + ' 个')

    const on = tabs.find((t) => t.classList.contains('on'));
    const hv = tabs.find((t) => t.classList.contains('hv'));
    const onShadow = getComputedStyle(on).boxShadow;
    const hvShadow = hv ? getComputedStyle(hv).boxShadow : 'none';

    /* 至少有一个态真的有阴影 */
    ok(no + ' 有阴影', onShadow !== 'none' || hvShadow !== 'none', onShadow === 'none' ? '仅 hover' : '激活态');

    shadows.push({ no, onShadow, hvShadow });

    /* 净可见：每一层的 y 偏移（取绝对值）+ 模糊 − 收缩（正向） */
    const reach = (s) => {
      const ls = parseShadow(s).filter((l) => !l.inset);
      return ls.length ? Math.max(...ls.map((l) => Math.abs(l.y) + l.blur + l.spread)) : 0;
    };
    const r1 = reach(onShadow), r2 = reach(hvShadow);
    const r = Math.max(r1, r2);
    if (r > maxReach) { maxReach = r; maxReachNo = no; }
    ok(no + ' 外阴影净可见 ≤ 4px', r <= 4.01, r.toFixed(1) + 'px');
  });

  /* 十套互不重复（激活 + hover 组合值去重） */
  const uniq = new Set(shadows.map((s) => s.onShadow + '|' + s.hvShadow));
  ok('十套阴影两两不同', uniq.size === 10, uniq.size + ' 种');

  /* 无 overflow 裁切风险：stage / tbar 不得为 hidden */
  const bad = plans.filter((p) => {
    const st = getComputedStyle(p.querySelector('.stage'));
    const tb = getComputedStyle(p.querySelector('.tbar'));
    return [st.overflow, st.overflowY, tb.overflow, tb.overflowY].some((v) => v === 'hidden');
  });
  ok('样机未被 overflow 裁切', bad.length === 0, bad.length ? bad.length + ' 套有 hidden' : 'ok');

  ok('页面无横向滚动', document.documentElement.scrollWidth <= window.innerWidth + 1,
     document.documentElement.scrollWidth + ' vs ' + window.innerWidth);

  return { out, maxReach: +maxReach.toFixed(1), maxReachNo };
})()
`

const res = await ev(probe)
if (!res || res.__err) {
  console.error('探针失败:', JSON.stringify(res).slice(0, 600))
  chrome.kill()
  process.exit(1)
}

let fails = 0
for (const c of res.out) {
  if (!c.pass) { console.log(`✘ ${c.name}  [${c.detail}]`); fails++ }
}

/* 皮肤跟随：浅色 vs 暗色，同一套的阴影色应不同 */
/*
 * 注意：01 与 09 现在带 box-shadow 的 transition（160ms），
 * 切主题后立刻读 computed 会拿到「过渡起点」的旧颜色 —— 必须等过渡结束。
 * （第一版没等，浅色/暗色读出来一模一样，误判成「墨色没随皮肤变」。）
 */
const skinProbe = await ev(`
(async () => {
  const wait = () => new Promise((r) => setTimeout(r, 320));
  const pick = () => getComputedStyle(document.querySelector('.plan[data-p="1"] .tab.on')).boxShadow;
  const inkOf = () => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();

  document.documentElement.dataset.theme = 'light';
  await wait();
  const l = pick(), inkLight = inkOf();

  document.documentElement.dataset.theme = 'dark';
  await wait();
  const d = pick(), inkDark = inkOf();

  document.documentElement.dataset.theme = 'ocean';
  await wait();
  const o = pick(), inkOcean = inkOf();

  document.documentElement.dataset.theme = 'light';
  await wait();

  return { l, d, o, lightNeDark: l !== d, darkNeOcean: d !== o,
           inkLight, inkDark, inkOcean,
           inkDiffers: inkLight !== inkDark,
           darkFamilySame: inkDark === inkOcean };
})()
`)
const extra = []
if (skinProbe?.lightNeDark) extra.push({ name: '阴影随皮肤换色（浅 ≠ 暗）', pass: true, detail: '' })
else extra.push({ name: '阴影随皮肤换色（浅 ≠ 暗）', pass: false, detail: 'light 与 dark 相同' })
if (skinProbe?.inkDiffers) extra.push({ name: '浅色墨 ≠ 暗色墨（--ink 随皮肤）', pass: true, detail: `${skinProbe.inkLight} vs ${skinProbe.inkDark}` })
else extra.push({ name: '浅色墨 ≠ 暗色墨（--ink 随皮肤）', pass: false, detail: '浅暗墨色相同' })
/* 暗色系共用纯黑墨是有意为之：视觉差异来自各自的 --bg-panel，不必也不同 */
if (skinProbe?.darkFamilySame) extra.push({ name: '暗色系共用纯黑墨（设计意图）', pass: true, detail: skinProbe.inkDark })
else extra.push({ name: '暗色系共用纯黑墨（设计意图）', pass: false, detail: `${skinProbe.inkDark} / ${skinProbe.inkOcean}` })

for (const c of extra) {
  if (!c.pass) { console.log(`✘ ${c.name}  [${c.detail}]`); fails++ }
}

if (errors.length) {
  console.log('\nJS 异常:')
  errors.forEach((e) => console.log('  ' + e.split('\n')[0]))
  fails += errors.length
}

const total = res.out.length + extra.length
console.log(`\n最大外阴影净可见：${res.maxReach}px（${res.maxReachNo}）`)
console.log(`${fails === 0 ? '✅ 全部通过' : '❌ ' + fails + ' 项未通过'}（共 ${total} 项断言，仅列失败项）`)
chrome.kill()
process.exit(fails === 0 ? 0 : 1)
