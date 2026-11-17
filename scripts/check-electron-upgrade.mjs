/**
 * Electron 34 → 45 升级预检（只读）
 *
 * 静态扫描本项目对官方 breaking changes 的命中点，供每一级升级前后复跑。
 * 特点：零依赖、不联网、不启动浏览器、不截图、不写任何文件。
 *
 * 用法：
 *   node scripts/check-electron-upgrade.mjs            # 只报告，退出码恒 0
 *   node scripts/check-electron-upgrade.mjs --strict  # 有硬阻断时退出码 1
 *
 * 命中等级：
 *   block = 该版本起直接不可用，必须改代码
 *   warn  = 弃用 / 行为变化，需要验证或排期迁移
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['electron', 'src', 'shared']
const EXTS = new Set(['.ts', '.tsx', '.mjs', '.js'])

function collect(dir) {
  const out = []
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return out
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, e.name)
    if (e.isDirectory()) out.push(...collect(path.join(dir, e.name)))
    else if (EXTS.has(path.extname(e.name))) out.push(path.relative(ROOT, p))
  }
  return out
}

const FILES = DIRS.flatMap(collect)
const cache = new Map()
function text(rel) {
  if (!cache.has(rel)) cache.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'))
  return cache.get(rel)
}

/** 找出所有命中的行号与片段 */
function hits(rel, re) {
  const out = []
  text(rel).split('\n').forEach((line, i) => {
    if (re.test(line)) out.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`)
  })
  return out
}

/** 按文件过滤 + 扫描 */
function scan(filter, re) {
  return FILES.filter(filter).flatMap((rel) => hits(rel, re))
}

const isRenderer = (rel) => rel.startsWith('src' + path.sep)
const isPreload = (rel) => rel.endsWith(path.join('electron', 'preload.ts'))
const isMain = (rel) => rel.startsWith('electron' + path.sep)

const CHECKS = [
  {
    id: '44 · renderer 直接使用 electron clipboard（已移除）',
    level: 'block',
    run: () => scan(isRenderer, /import\s*\{[^}]*\bclipboard\b[^}]*\}\s*from\s*['"]electron['"]|require\(['"]electron['"]\)\.clipboard/),
    note: '渲染层应统一用 navigator.clipboard；主进程权限策略按 W3C 权限名放行。',
  },
  {
    id: '45 · sandboxed preload 使用 Node shims / Buffer / setImmediate（已移除）',
    level: 'block',
    run: () => scan(isPreload, /require\(['"](events|timers|url)['"]\)|\bBuffer\b|\bsetImmediate\b|\bclearImmediate\b/),
    note: '改用 Uint8Array / TextEncoder / setTimeout / queueMicrotask；ipcRenderer 与 process 的 EventEmitter 方法仍可用。',
  },
  {
    id: '35 · webRequest 过滤器 urls: []（不再匹配所有 URL）',
    level: 'block',
    run: () => scan(isMain, /urls\s*:\s*\[\s*\]/),
    note: '必须显式写 urls: [\'<all_urls>\']；本项目当前用无 filter 的两参数形式。',
  },
  {
    id: '45 · safeStorage 同步 API（弃用，46 移除）',
    level: 'warn',
    run: () => scan(isMain, /safeStorage\.(encryptString|decryptString|isEncryptionAvailable)\s*\(/),
    note: '迁移到 encryptStringAsync / decryptStringAsync；用 encryptString 加密的数据仍可用 decryptStringAsync 解密。',
  },
  {
    id: '43 · dialog 调用缺少 defaultPath（默认目录改 Downloads）',
    level: 'warn',
    run: () => {
      const out = []
      for (const rel of FILES.filter(isMain)) {
        const lines = text(rel).split('\n')
        lines.forEach((line, i) => {
          if (/dialog\.show(Open|Save)Dialog(Sync)?\s*\(/.test(line)) {
            const block = lines.slice(i, i + 10).join('\n')
            if (!/defaultPath/.test(block)) out.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`)
          }
        })
      }
      return out
    },
    note: '未传 defaultPath 时新版本默认打开 Downloads，且不再记忆上次目录。',
  },
  {
    id: '36 · app.commandLine（大写参数被转小写，行为变化）',
    level: 'warn',
    run: () => scan(isMain, /\bapp\.commandLine\b/),
    note: '控制主进程行为应改用 process.argv。',
  },
  {
    id: '44 · 已移除 API（isUnityRunning / PrinterInfo / webFrame.routingId / NativeImage.getBitmap）',
    level: 'block',
    run: () => scan(() => true, /\b(app\.isUnityRunning|PrinterInfo|webFrame\.routingId|NativeImage\.getBitmap)\b/),
    note: '这些 API 在 36–44 之间被移除，命中即需改代码。',
  },
  {
    id: '45 · ASAR 内文件 fd 交给非 fs 消费者（已失效）',
    level: 'block',
    run: () => scan(isMain, /net\.Socket\(\s*\{[^}]*\bfd\b|respondWithFile|respondWithFD|child_process[^\n]*\bstdio\b/),
    note: '新版本 asar 内 fd 只能通过 fs 读取，raw descriptor 会返回 EBADF。',
  },
  {
    id: '44 · net.request 手动设置 Sec-Fetch-Dest（frame 目标受限）',
    level: 'warn',
    run: () => scan(isMain, /Sec-Fetch-Dest/),
    note: 'frame 类目标需同时带 Sec-Fetch-Mode: navigate。',
  },
  {
    id: '39/45 · window.open 子窗口行为变化',
    level: 'warn',
    run: () => scan(() => true, /\bwindow\.open\s*\(/),
    note: '39 起弹窗恒可调整大小；45 起子窗口默认独立 sandbox process，需核对 setWindowOpenHandler。',
  },
]

let blocks = 0
let warns = 0
console.log(`Electron 34→45 升级预检（只读） · 扫描 ${FILES.length} 个源码文件\n`)
for (const c of CHECKS) {
  const found = c.run()
  const bad = found.length > 0
  if (bad && c.level === 'block') blocks++
  if (bad && c.level === 'warn') warns++
  console.log(`${bad ? (c.level === 'block' ? '[BLOCK]' : '[WARN] ') : '[OK]   '} ${c.id}`)
  if (bad) found.slice(0, 8).forEach((line) => console.log(`         ${line}`))
  if (bad) console.log(`         → ${c.note}`)
}
console.log(`\n硬阻断 ${blocks} 项 / 需验证或排期 ${warns} 项。`)
console.log('说明：预检只覆盖静态可判定的 breaking changes；Node 20→24、Chromium 130→156、')
console.log('      electron-builder / electron-updater / vite-plugin-electron 兼容性、NSIS 与')
console.log('      CSP 双通道、凭据解密，仍必须靠打包版一次性真机验证，不能用本脚本代替。')
if (process.argv.includes('--strict') && blocks > 0) process.exit(1)
