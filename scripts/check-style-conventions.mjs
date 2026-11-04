/**
 * 样式规范静态校验（CI 用）
 *
 * 为什么是源码级而不是浏览器探针：
 *   scripts/check-lift-shadow.mjs 与 check-tab-lift.mjs 是开发期 CDP 探针，
 *   硬编码了本机 Chrome 路径、依赖本地预览服务（后者还依赖已停止跟踪的
 *   design/tab-shadow-10.html），在 Ubuntu CI 上根本跑不起来。
 *   这里把 docs/conventions.md 第 4/8 节里能用源码判定的部分抽成零依赖断言，
 *   与那两个探针互补：CI 守住「约定是否被改动」，本地探针守住「真实渲染效果」。
 *
 * 零依赖、不联网、不启动浏览器、不截图。
 * 用法：node scripts/check-style-conventions.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const main = read('src/styles/main.css')
const components = read('src/styles/components.css')
const cards = read('src/styles/tailwind-cards.css')

const checks = []
const ok = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail: String(detail) })

/* ---------------------------------------------------------------- 1. 令牌定义 */

const liftBlock = main.match(/--lift-shadow:\s*([\s\S]*?);/)?.[1] ?? ''
ok('--lift-shadow 有定义', liftBlock.length > 0)
ok('双层几何：近影 0 1px 1px + 远影 0 2px 3px -1px',
  /0 1px 1px/.test(liftBlock) && /0 2px 3px -1px/.test(liftBlock), liftBlock.trim().replace(/\s+/g, ' '))
ok('两层都引用 alpha 变量（不写死颜色）',
  /--lift-a1/.test(liftBlock) && /--lift-a2/.test(liftBlock))

/* ------------------------------------------------------- 2. 九套皮肤的 alpha */

const a1 = [...main.matchAll(/--lift-a1:\s*([\d.]+);/g)].map((m) => m[1])
const a2 = [...main.matchAll(/--lift-a2:\s*([\d.]+);/g)].map((m) => m[1])
ok('--lift-a1 / --lift-a2 各定义 9 处（每套皮肤一档）', a1.length === 9 && a2.length === 9,
  `a1=${a1.length} a2=${a2.length}`)
ok('暗色 3 套 .30 / 浅色 6 套 .13',
  a1.filter((v) => v === '.30').length === 3 && a1.filter((v) => v === '.13').length === 6, a1.join(','))
ok('远影 alpha 与近影同步（.345 / .19）',
  a2.filter((v) => v === '.345').length === 3 && a2.filter((v) => v === '.19').length === 6, a2.join(','))

/* dark 是 :root 默认档，不写显式 data-theme 块；其余 8 套各有显式块 */
const EXPLICIT_THEMES = ['light', 'solarized', 'sakura', 'mint', 'mist', 'aurora', 'ocean', 'forest']
const missingThemes = EXPLICIT_THEMES.filter((t) => !new RegExp(`data-theme=['"]${t}['"]`).test(main))
ok('8 套显式皮肤块齐全（dark 为 :root 默认档）',
  missingThemes.length === 0 && /:root\s*\{/.test(main),
  missingThemes.join(',') || EXPLICIT_THEMES.length + ' 套 + 默认 dark')

/* --------------------------------------------------------- 3. 胶囊按钮白名单 */

const pillBlocks = [...main.matchAll(/([^{}]+)\{\s*border-radius:\s*999px\s*!important;\s*\}/g)].map((m) => m[1])
const pill = pillBlocks.find((s) => s.includes('.btn')) ?? ''
ok('胶囊白名单存在且带 !important', pill.length > 0)
const PILL_REQUIRED = ['.btn', '.btn-primary', '.add-btn', '.bar-btn', '.del-btn', '.more-btn', '.tabbar-btn']
const missingPill = PILL_REQUIRED.filter((c) => !pill.includes(c))
ok('白名单覆盖关键按钮类', missingPill.length === 0, missingPill.join(',') || PILL_REQUIRED.length + ' 类')

/* --------------------------------------------------- 4. 选中态 / hover 阴影 */

const shadowDecls = [...components.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1].replace(/\s+/g, ' ').trim())
/*
 * 只校验「按钮选中态」：输入框 :focus 的单层 inset 品牌描边是另一套语义，
 * 不该被要求叠加浮起外影。规则按选择器里的 .on / .active 识别。
 */
const rules = [...components.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  sel: m[1].replace(/\s+/g, ' ').trim(), body: m[2],
}))
const selected = rules.filter((r) => /\.on\b|\.active\b/.test(r.sel)
  && /box-shadow:\s*inset 0 0 0 1px var\(--accent\)/.test(r.body))
ok('存在「inset 品牌描边」按钮选中态规则', selected.length >= 2, selected.length + ' 条')
ok('按钮选中态都同时叠加 var(--lift-shadow)',
  selected.length > 0 && selected.every((r) => /var\(--lift-shadow\)/.test(r.body)))
const hardcoded = shadowDecls.filter((s) => /0 1px 1px|0 2px 3px -1px/.test(s))
ok('组件里不硬编码浮起几何', hardcoded.length === 0,
  hardcoded.length ? hardcoded[0].slice(0, 70) : '全部走变量')
const uses = (components.match(/var\(--lift-shadow\)/g) || []).length
ok('浮起阴影被多处复用', uses >= 10, uses + ' 处')

/* ------------------------------------------- 5. Tailwind 覆盖必须在 @layer 之外 */

/**
 * 计算某位置之前「未闭合花括号」的深度；0 = 顶层（未分层）。
 * 必须先按等长空白剥离注释：注释里的 { } 会让朴素栈算法多算一层
 * （本文件 668 行那段长注释就含多个花括号）。
 */
function depthAt(text, pos) {
  const head = text.slice(0, pos).replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  return (head.match(/\{/g) || []).length - (head.match(/\}/g) || []).length
}
const bgWhitePos = cards.indexOf('.feat-card .bg-white')
ok('存在 .feat-card .bg-white 覆盖规则', bgWhitePos >= 0)
ok('该覆盖位于所有 @layer 之外（否则被 utilities 静默压过）',
  bgWhitePos >= 0 && depthAt(cards, bgWhitePos) === 0, '深度 ' + (bgWhitePos >= 0 ? depthAt(cards, bgWhitePos) : 'n/a'))

/* ------------------------------------------------------------------- 输出 */

let fails = 0
for (const c of checks) {
  console.log(`${c.pass ? '✔' : '✘'} ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`)
  if (!c.pass) fails++
}
console.log(`\n${fails === 0 ? '✅ 样式规范全部通过' : '❌ ' + fails + ' 项未通过'}（共 ${checks.length} 项断言）`)
console.log('说明：本脚本只做源码级断言；真实 hover / 计算样式仍由两个 CDP 探针在本地验证。')
process.exit(fails === 0 ? 0 : 1)
