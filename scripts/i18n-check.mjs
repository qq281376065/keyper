import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import babelParser from '@babel/parser'

/*
 * 语义 key 字典校验。
 *
 * 英文目录 lang/en.ts 是唯一事实来源：key 由它推导成 MsgKey 类型，
 * 另外两份字典在编译期按 Record<MsgKey, string> 检查。这个脚本补上
 * 运行期/静态检查兜不住的部分：
 *   1. 三份字典的键集、占位符集合必须一致；
 *   2. key 必须符合 namespace.camelCase 形式，英文值不得残留中文
 *      （语言本名 locale.* 除外）；
 *   3. 源码里 t('...') 的字面量 key 必须存在于目录；
 *   4. 报告从未被源码引用的 key，避免删功能后留下死文案。
 *
 * 用法：npm run i18n:check
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['src', 'shared', 'electron']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'release', '.git'])
const LANGS = {
  en: { file: path.join(ROOT, 'lang/en.ts'), varName: 'en' },
  'zh-CN': { file: path.join(ROOT, 'lang/zh-CN.ts'), varName: 'zhCN' },
  'zh-TW': { file: path.join(ROOT, 'lang/zh-TW.ts'), varName: 'zhTW' },
}
const KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/
const PLACEHOLDER_RE = /\{(\w+)\}/g
const CJK_RE = /[\u3400-\u9fff]/

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && entry.name !== 'lang') walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/*
 * TypeScript 7 是原生实现，不再导出 JS 编译器 API（ts.createSourceFile 等），
 * 因此这里改用 Babel 解析器，脚本只依赖 AST 节点类型，不依赖具体编译器。
 */
function parse(file) {
  return babelParser.parse(fs.readFileSync(file, 'utf8'), {
    sourceType: 'module',
    plugins: ['typescript', ...(file.endsWith('x') ? ['jsx'] : [])],
  })
}

/** 字符串字面量与无插值模板字面量取文本，其余返回 null */
function stringText(node) {
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked
  }
  return null
}

function unwrapExpression(node) {
  let current = node
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'ParenthesizedExpression')
  ) {
    current = current.expression
  }
  return current
}

/** 深度遍历 AST，跳过位置与注释等非节点字段 */
function walkAst(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'loc' ||
      key === 'start' ||
      key === 'end' ||
      key === 'extra' ||
      key === 'comments' ||
      key === 'leadingComments' ||
      key === 'trailingComments' ||
      key === 'innerComments'
    ) {
      continue
    }
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit)
    } else if (value && typeof value === 'object') {
      walkAst(value, visit)
    }
  }
}

/** 从 `const en = { ... } as const` 这类声明里取出对象字面量 */
function readCatalog(file, varName) {
  const source = parse(file)
  let object
  for (const stmt of source.program.body) {
    if (stmt.type !== 'VariableDeclaration') continue
    for (const decl of stmt.declarations) {
      if (decl.id.type !== 'Identifier' || decl.id.name !== varName || !decl.init) continue
      const init = unwrapExpression(decl.init)
      if (init.type === 'ObjectExpression') object = init
    }
  }
  if (!object) throw new Error(`${path.relative(ROOT, file)} 里找不到 ${varName} 对象`)

  const entries = new Map()
  for (const prop of object.properties) {
    if (prop.type !== 'ObjectProperty' || prop.computed) continue
    const name = prop.key.type === 'StringLiteral' ? prop.key.value : null
    if (name === null) continue
    const text = stringText(prop.value)
    if (text === null) throw new Error(`${name}: 译文必须是字符串字面量`)
    if (entries.has(name)) throw new Error(`${path.relative(ROOT, file)} 含重复 key: ${name}`)
    entries.set(name, text)
  }
  return entries
}

function placeholders(text) {
  return [...text.matchAll(PLACEHOLDER_RE)]
    .map((m) => m[1])
    .sort()
    .join(',')
}

const catalogs = Object.fromEntries(
  Object.entries(LANGS).map(([locale, cfg]) => [locale, readCatalog(cfg.file, cfg.varName)]),
)
const keys = [...catalogs.en.keys()].sort()
const keySet = new Set(keys)

const problems = []
function problem(message) {
  problems.push(message)
}

/* ---------------------------------------------------------------- 字典一致性 */

for (const key of keys) {
  if (!KEY_RE.test(key)) problem(`key 格式不合法: ${key}`)
}

for (const locale of ['zh-CN', 'zh-TW']) {
  const dict = catalogs[locale]
  for (const key of keys) {
    if (!dict.has(key)) {
      problem(`${locale} 缺少: ${key}`)
      continue
    }
    const expected = placeholders(catalogs.en.get(key))
    const actual = placeholders(dict.get(key))
    if (expected !== actual) problem(`${locale} 占位符不一致: ${key} (${actual} != ${expected})`)
  }
  for (const key of dict.keys()) {
    if (!keySet.has(key)) problem(`${locale} 多出: ${key}`)
  }
}

for (const [key, value] of catalogs.en) {
  if (CJK_RE.test(value) && !key.startsWith('locale.')) {
    problem(`英文译文含中文: ${key} = ${value}`)
  }
}

/* ---------------------------------------------------------------- 源码引用 */

const used = new Set()
const badCalls = []
for (const root of ROOTS) {
  for (const file of walk(path.join(ROOT, root))) {
    if (file === path.join(ROOT, 'src/api/mock.ts')) continue
    const source = parse(file)
    walkAst(source.program, (node) => {
      if (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') {
        const text = stringText(node)
        if (text !== null && keySet.has(text)) used.add(text)
      }
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        (node.callee.name === 't' || node.callee.name === 'tr')
      ) {
        const text = stringText(node.arguments[0] ?? {})
        if (text !== null && !keySet.has(text)) {
          badCalls.push(`${path.relative(ROOT, file)}:${node.loc.start.line} → ${text}`)
        }
      }
    })
  }
}

for (const call of badCalls) problem(`t() 的 key 不在目录中: ${call}`)

/*
 * locale.* 是语言本名（简体中文 / 繁體中文 / English），由 LOCALE_NAMES
 * 直接持有原文、不从 t() 取，属于合理例外。
 */
const unused = keys.filter((key) => !used.has(key) && !key.startsWith('locale.'))
for (const key of unused) problem(`未被源码引用: ${key}`)

/* ---------------------------------------------------------------- 输出 */

console.log(`语义 key: ${keys.length}`)
console.log(`源码引用: ${used.size}`)
if (problems.length) {
  console.error(`\n发现 ${problems.length} 个问题：`)
  for (const message of problems) console.error(`  ${message}`)
  process.exit(1)
}
console.log('三份字典键集、占位符与源码引用一致')