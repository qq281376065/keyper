/**
 * 样式隔离重建：把 components.css 里各组件的平铺样式重新加回命名空间。
 *
 * 背景（本次移植最大的系统性缺陷）：
 * Vue 的 <style scoped> 给选择器加 data-v 属性实现组件隔离，因此 35 个
 * 弹窗可以各自定义 .dialog / .mask / .dialog-head / .dialog-foot 等同名类。
 * 平铺进一份全局 CSS 后隔离消失 —— 后出现的定义覆盖先前的：
 * LogPanel 的 .dialog{width:600px} 盖掉了所有弹窗的 440/520/760px 宽度，
 * max-height/overflow 约束也被互相污染，直接表现为「弹窗内组件错位」。
 *
 * 修复策略（与 scoped 语义等价、零手工）：
 *   把每个组件段包进 `.s-<组件名>` 容器选择器，并把段内**每条规则**的
 *   每个选择器都加前缀，最后一段的同类名覆盖问题就此消失；
 *   对「跨组件引用」（原 :deep / 跨组件类名，如 .sortable:hover .sort-tri）
 *   保持全局（不加前缀）—— 与 Vue scoped 的跨组件规则行为一致。
 *
 * 用法：node scripts/rescope-css.mjs（写回 src/styles/components.css）
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = path.join(process.cwd(), 'src', 'styles', 'components.css')

/** Vue scoped 下允许跨组件命中的已知类（原样保留全局，不加前缀） */
const GLOBAL_SELECTOR_PATTERNS = [
  /^body\b/,
  /^html\b/,
  /^\*/,
  /^@media/,
  /^@keyframes/,
  /^@font-face/,
]

/** 组件段注释形如「/* Xxx.vue *\/」 */
const SECTION_RE = /^\/\* (\S+\.vue) \*\/\s*$/

/** 把一段 CSS 文本按顶层规则切开（保留 @media 嵌套为整体） */
function splitRules(css) {
  const rules = []
  let buf = ''
  let depth = 0
  let i = 0
  while (i < css.length) {
    const ch = css[i]
    if (ch === '{') depth++
    if (ch === '}') depth--
    buf += ch
    if (depth === 0 && ch === '}') {
      rules.push(buf)
      buf = ''
    } else if (depth === 0 && ch === '}' ) {
      buf = ''
    }
    i++
  }
  if (buf.trim()) rules.push(buf)
  return rules
}

/** 解析规则头（选择器部分） */
function headOf(rule) {
  const open = rule.indexOf('{')
  return open < 0 ? null : { head: rule.slice(0, open), body: rule.slice(open) }
}

/** 判断规则是否应保持全局 */
function isGlobal(head) {
  return GLOBAL_SELECTOR_PATTERNS.some((re) => re.test(head.trim()))
}

/** 给选择器列表加前缀（逗号分隔的每个选择器都加） */
function prefixSelectors(head, ns) {
  return head
    .split(',')
    .map((sel) => {
      const t = sel.trim()
      if (!t) return t
      if (isGlobal(t)) return t
      return `${ns} ${t}`
    })
    .join(', ')
}

/** 对 @media 块递归处理内部规则 */
function processRule(rule, ns) {
  const parsed = headOf(rule)
  if (!parsed) return rule
  const head = parsed.head
  const trimmed = head.trim()

  // at-rule：@media 递归；@keyframes 保持原样
  if (trimmed.startsWith('@media')) {
    const inner = rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}'))
    const innerRules = splitRules(inner)
    return (
      head +
      '{\n' +
      innerRules
        .map((r) => processRule(r, ns))
        .join('\n') +
      '\n}'
    )
  }
  if (trimmed.startsWith('@')) return rule

  if (isGlobal(trimmed)) return rule
  const newHead = prefixSelectors(head, ns)
  return newHead + parsed.body
}

function main() {
  const src = fs.readFileSync(FILE, 'utf8')

  // 文件头（第一段 section 注释之前的全局说明）保持原样
  const firstSection = src.search(SECTION_RE)
  if (firstSection < 0) throw new Error('未找到组件段注释')
  const fileHead = src.slice(0, firstSection)

  // 按「/* Xxx.vue *\/」切段
  const lines = src.slice(firstSection).split('\n')
  const sections = []
  let current = null
  for (const line of lines) {
    const m = line.match(SECTION_RE)
    if (m) {
      current = { name: m[1], body: [] }
      sections.push(current)
      continue
    }
    if (current) current.body.push(line)
  }

  const out = [fileHead]
  for (const sec of sections) {
    // 命名空间类名：ConnectionDialog.vue → .s-connection-dialog
    const base = sec.name.replace(/\.vue$/, '')
    const ns = '.s-' + base.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
    const css = sec.body.join('\n').trim()
    const rules = splitRules(css)
    const scoped = rules.map((r) => processRule(r, ns)).join('\n')
    out.push(`\n/* ${sec.name} —— 作用域 ${ns} */\n${ns} {\n  /* 容器占位：样式挂在后代选择器上 */\n}\n${scoped}\n`)
  }

  fs.writeFileSync(FILE, out.join('\n'), 'utf8')
  console.log(`已重建 ${sections.length} 个组件的作用域`)
}

main()
