#!/usr/bin/env node
/**
 * 构建期 CSP hash 处理。
 *
 * 背景：index.html 里有一段「首屏主题脚本」，必须在 React 挂载前同步执行，
 * 否则会先渲染亮色再切暗色（DEV 里肉眼可见的闪烁）。生产 CSP 不允许
 * script unsafe-inline，因此这段内联脚本只能靠 sha256 hash 精确放行。
 *
 * 问题：hash 是脚本正文的 sha256，脚本改一个字符 hash 就失效 ——
 * 脚本被拦后主题会闪，而且 CSP 违规只在控制台可见，很容易漏过。
 *
 * 本脚本做两件事：
 *   1. 扫描构建产物 index.html 里所有内联 <script>
 *   2. 计算 sha256 并写进 <meta http-equiv="Content-Security-Policy">
 *      （meta CSP 是 file:// 协议下唯一生效的注入方式）
 *
 * 用法：node scripts/csp-hash.mjs [--check]
 *   --check 只校验不写入，hash 不一致时以非零码退出（供 CI 使用）
 *
 * 之所以操作「构建产物 dist/index.html」而非源文件：
 * 源 index.html 由 Vite 处理，构建后内联脚本的空白/换行可能被规范化，
 * 对产物算 hash 才能保证与实际执行的字节完全一致。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_HTML = path.join(ROOT, 'dist', 'index.html')
const isCheck = process.argv.includes('--check')

/** 与 electron/main.ts 的 CSP_PROD 保持一致（不含 hash 部分） */
const CSP_DIRECTIVES = [
  "default-src 'none'",
  'style-src \'self\'',
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
]

if (!existsSync(DIST_HTML)) {
  console.error('[csp-hash] 找不到 dist/index.html，请先执行 vite build')
  process.exit(1)
}

const html = readFileSync(DIST_HTML, 'utf-8')

/*
 * 提取所有内联 <script>（无 src 属性）。
 * 用 [\s\S] 而非 . 是因为正文含换行；非贪婪保证只匹配到最近的闭合标签。
 */
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
  (m) => m[1],
)

if (inlineScripts.length === 0) {
  console.log('[csp-hash] 无内联脚本，跳过')
  process.exit(0)
}

const hashes = inlineScripts.map(
  (body) => `'sha256-${createHash('sha256').update(body, 'utf-8').digest('base64')}'`,
)

const csp = [`script-src 'self' ${hashes.join(' ')}`, ...CSP_DIRECTIVES].join('; ')

const META_RE = /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i
const META_TAG = `<meta http-equiv="Content-Security-Policy" content="${csp}">`

let next
if (META_RE.test(html)) {
  next = html.replace(META_RE, META_TAG)
} else {
  /*
   * 插到 </head> 前：CSP meta 必须出现在任何资源引用之前才有效，
   * 而 Vite 产物的 script/link 都在 head 内，插在 head 末尾仍早于
   * 外部脚本执行，足够。
   */
  next = html.replace(/<\/head>/i, `  ${META_TAG}\n  </head>`)
}

if (next === html && META_RE.test(html)) {
  console.log('[csp-hash] meta CSP 已是最新')
  process.exit(0)
}

if (isCheck) {
  console.error('[csp-hash] ✗ dist/index.html 的 CSP 与实际内联脚本不匹配')
  console.error(`           期望 hash: ${hashes.join(', ')}`)
  process.exit(1)
}

writeFileSync(DIST_HTML, next, 'utf-8')
console.log(`[csp-hash] ✓ 已写入 ${inlineScripts.length} 个内联脚本的 hash`)
for (const h of hashes) console.log(`           ${h}`)
