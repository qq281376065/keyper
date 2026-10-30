import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

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

function parse(file) {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

/** 从 `const en = { ... } as const` 这类声明里取出对象字面量 */
function readCatalog(file, varName) {
  const source = parse(file)
  let object
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== varName || !decl.initializer) continue
      let init = decl.initializer
      if (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression
      if (ts.isObjectLiteralExpression(init)) object = init
    }
  })
  if (!object) throw new Error(`${path.relative(ROOT, file)} 里找不到 ${varName} 对象`)

  const entries = new Map()
  for (const prop of object.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const name = ts.isStringLiteral(prop.name) ? prop.name.text : null
    if (name === null) continue
    const value = prop.initializer
    if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) {
      throw new Error(`${name}: 译文必须是字符串字面量`)
    }
    if (entries.has(name)) throw new Error(`${path.relative(ROOT, file)} 含重复 key: ${name}`)
    entries.set(name, value.text)
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
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (keySet.has(node.text)) used.add(node.text)
        const parent = node.parent
        if (
          parent &&
          ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          ts.isIdentifier(parent.expression) &&
          (parent.expression.text === 't' || parent.expression.text === 'tr') &&
          !keySet.has(node.text)
        ) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
          badCalls.push(`${path.relative(ROOT, file)}:${line} → ${node.text}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
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