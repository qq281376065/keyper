import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * 从源码里的中文字面量生成本地化清单。
 *
 * 源语言是中文，键即原文。本脚本做三件事：
 *   1. 扫描 src / shared / electron 下所有中文字符串字面量，汇总键。
 *      不只收 t('...') 调用：主题名、字体名、表头映射这类文案写在模块级
 *      常量里、渲染时才 t(常量)，静态调用扫描抓不到，但同样要进字典；
 *   2. 重写 lang/zh-CN.ts（简体字典即身份映射）；
 *   3. 报告 en / zh-TW 缺失与多余的键（--check 时以非零码退出，供测试使用）。
 *
 * 只收字面量键：动态拼接的键无法静态提取，调用处应改成带 {占位符} 的完整句子。
 * 含 ${} 的模板串与 console.* 里的开发日志不收 —— 前者应改成 t(占位符)，
 * 后者不面向用户。src/api/mock.ts 是浏览器预览用的假数据，也不收。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['src', 'shared', 'electron']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'release', '.git'])
const SKIP_FILES = new Set([path.join(ROOT, 'src/api/mock.ts')])
const LOCALES_DIR = path.join(ROOT, 'lang')
const LOCALE_FILES = {
  'zh-CN': path.join(LOCALES_DIR, 'zh-CN.ts'),
  'zh-TW': path.join(LOCALES_DIR, 'zh-TW.ts'),
  en: path.join(LOCALES_DIR, 'en.ts'),
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** 去掉注释，避免注释里的示例 t('...') 混进清单 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1')
}

/** 单双引号字符串（模板串单独判断，含 ${} 的跳过） */
const STRING_RE = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g
const CJK_RE = /[\u3400-\u9fff]/
const CONSOLE_PREFIX_RE = /console\s*\.\w+\([^;]*$/

function unescape(raw) {
  return raw.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

function escape(key) {
  return key.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')
}

function collectKeys() {
  const byFile = new Map()
  const all = new Set()
  for (const root of ROOTS) {
    for (const file of walk(path.join(ROOT, root))) {
      if (file.startsWith(LOCALES_DIR) || SKIP_FILES.has(file)) continue
      const src = stripComments(fs.readFileSync(file, 'utf8'))
      const re = new RegExp(STRING_RE.source, 'g')
      let match
      while ((match = re.exec(src))) {
        const raw = match[2]
        /* ${} 模板串没法直接当键，调用处应改成 t('带 {占位符} 的句子') */
        if (raw.includes('${') || raw.includes('\n')) continue
        const key = unescape(raw)
        if (!CJK_RE.test(key)) continue
        const lineStart = src.lastIndexOf('\n', match.index) + 1
        if (CONSOLE_PREFIX_RE.test(src.slice(lineStart, match.index))) continue
        if (all.has(key)) continue
        all.add(key)
        byFile.set(file, (byFile.get(file) ?? 0) + 1)
      }
    }
  }
  return { keys: [...all].sort(), byFile }
}

const DICT_ENTRY_RE = /^\s*'((?:\\.|[^'\\])*)':\s*'((?:\\.|[^'\\])*)',?\s*$/gm

function readDict(file) {
  const src = fs.readFileSync(file, 'utf8')
  const entries = new Map()
  let match
  while ((match = DICT_ENTRY_RE.exec(src))) entries.set(unescape(match[1]), unescape(match[2]))
  return entries
}

const PLACEHOLDER_RE = /\{(\w+)\}/g

/** 占位符集合指纹：{a} {b} 与 {b} {a} 视为一致，顺序不影响 */
function placeholderKey(text) {
  return [...text.matchAll(PLACEHOLDER_RE)]
    .map((match) => match[1])
    .sort()
    .join(',')
}

function writeZhCN(keys) {
  const lines = keys.map((key) => `  '${escape(key)}': '${escape(key)}',`).join('\n')
  const content = `import type { Dict } from '../shared/i18n'

/**
 * 中文（简体）—— 源语言。
 *
 * 键即原文，所以值通常与键相同。看起来"重复"，但三份字典保持完全对称：
 * 新增文案时三份一起补，单元测试才能校验键集一致；
 * 也保留了对个别文案做同义替换（不改代码里的调用键）的余地。
 *
 * 本文件由 \`npm run i18n:manifest\` 从代码中的 t(...) 调用生成，请勿手改。
 */
const zhCN: Dict = {
${lines}
}

export default zhCN
`
  fs.writeFileSync(LOCALE_FILES['zh-CN'], content)
}

const { keys, byFile } = collectKeys()
const keySet = new Set(keys)

const checkMode = process.argv.includes('--check')
const top = [...byFile.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .map(([file, count]) => `${count}\t${path.relative(ROOT, file)}`)

console.log(`扫描到 ${keys.length} 个键，分布在 ${byFile.size} 个文件`)
console.log(top.join('\n'))

if (!checkMode) {
  writeZhCN(keys)
  console.log('已重写 lang/zh-CN.ts')
}

let problems = 0
for (const locale of ['zh-TW', 'en']) {
  const dict = readDict(LOCALE_FILES[locale])
  const dictKeys = new Set(dict.keys())
  const missing = keys.filter((key) => !dictKeys.has(key))
  const extra = [...dictKeys].filter((key) => !keySet.has(key))
  /* 占位符必须与原文一致，否则运行期会漏插值或残留 {name} 字面量 */
  const placeholderErrors = keys
    .filter((key) => dict.has(key) && placeholderKey(dict.get(key)) !== placeholderKey(key))
    .map((key) => `  ${key} → ${dict.get(key)}`)
  if (missing.length) {
    problems += missing.length
    console.log(`\n${locale} 缺失 ${missing.length} 条：`)
    console.log(missing.map((key) => `  ${key}`).join('\n'))
  }
  if (placeholderErrors.length) {
    problems += placeholderErrors.length
    console.log(`\n${locale} 占位符不一致 ${placeholderErrors.length} 条：`)
    console.log(placeholderErrors.join('\n'))
  }
  if (extra.length) {
    console.log(`\n${locale} 多余 ${extra.length} 条（代码里已不存在）：`)
    console.log(extra.map((key) => `  ${key}`).join('\n'))
  }
  if (!missing.length && !extra.length && !placeholderErrors.length) console.log(`${locale}: 键集与占位符一致`)
}

if (checkMode && problems) process.exit(1)
