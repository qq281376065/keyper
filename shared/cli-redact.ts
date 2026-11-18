/**
 * CLI 命令里的凭据打码（纯函数，主进程与渲染层共用）。
 *
 * 为什么需要：连接配置里的密码走 enc2 加密落盘，但用户在 CLI 手敲
 * `AUTH password` / `HELLO 3 AUTH user pass` 时，命令原文会进
 * 操作日志（ipc describe）与 CLI 历史（cli-history.json）——
 * 这两处都是明文持久化，等于绕过了加密层。
 *
 * 规则：只打码凭据参数，命令与其余参数原样保留（日志仍可对账）。
 *   · AUTH [username] password —— 1 参打码第 1 个，2 参打码第 2 个；
 *   · HELLO [protover [AUTH username password] [SETNAME name]] ——
 *     只打码 AUTH 后的两个参数，SETNAME 等非凭据参数保留。
 * 引号内的空格按 parseCommandLine 同规则切分（简化版：支持单双引号）。
 */

const MASK = '***'

/** 与主进程 parseCommandLine 同语义的轻量切分（这里只读不改，容错优先） */
function splitArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const char of input.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char as '"' | "'"
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current.length) {
        args.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
  }
  if (started || current.length) args.push(current)
  return args
}

/**
 * 返回打码后的命令文本；不含凭据的命令原样返回（trim 后）。
 * 打码位置按参数序号重建，保留原始大小写与其余参数原文。
 */
export function redactCliSecrets(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return trimmed
  const args = splitArgs(trimmed)
  const head = args[0]?.toUpperCase() ?? ''

  if (head === 'AUTH') {
    // AUTH password / AUTH username password
    const secretIndex = args.length >= 3 ? 2 : 1
    return args.map((a, i) => (i === secretIndex ? MASK : a)).join(' ')
  }

  if (head === 'HELLO') {
    // HELLO [protover] [AUTH username password] [SETNAME name]
    const out = [...args]
    for (let i = 1; i < out.length; i += 1) {
      if (out[i]?.toUpperCase() === 'AUTH') {
        if (i + 1 < out.length) out[i + 1] = MASK
        if (i + 2 < out.length) out[i + 2] = MASK
        i += 2
      }
    }
    return out.join(' ')
  }

  return trimmed
}

/** 命令是否携带凭据（用于决定渲染层要不要把原文放进会话历史） */
export function cliCommandHasSecret(command: string): boolean {
  const head = command.trim().split(/\s+/)[0]?.toUpperCase() ?? ''
  if (head === 'AUTH') return true
  if (head === 'HELLO') return /\bAUTH\b/i.test(command)
  return false
}