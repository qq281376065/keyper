/**
 * Redis / Memcached 连接串解析与批量导入。
 *
 * 支持常见形态：
 *   redis://:password@host:6379/0
 *   redis://user:password@host:6379/2
 *   rediss://host:6380/0                  → TLS
 *   redis://host:6379                    → 默认库 0、默认端口 6379
 *   memcached://host:11211               → Memcached（默认端口 11211）
 *   host:6379                            → 省略协议也接受（贴日志里常见）
 *   127.0.0.1                            → 只给地址，端口取 6379
 *
 * 为什么单独成模块：这段逻辑要能脱离组件单测。用户粘贴的来源五花八门
 * （命令行、配置文件、聊天记录、Docker inspect 输出），解析错了会连到
 * 完全无关的实例上，必须用测试把边界固定住。
 */
import type { CacheEngine } from '@shared/types'
import type { MsgKey, TParams } from '@shared/i18n'

export interface ParsedConnectionUri {
  engine: CacheEngine
  host: string
  port: number
  username?: string
  password?: string
  db: number
  tls: boolean
}

export interface ParseError {
  key: MsgKey
  params?: TParams
}

export type ParseResult =
  | { ok: true; value: ParsedConnectionUri }
  | { ok: false; error: ParseError }

const DEFAULT_REDIS_PORT = 6379
const DEFAULT_MEMCACHED_PORT = 11211
const MAX_DB = 15

/**
 * 解析一段可能是连接串的文本。
 *
 * 会先做一次"清洗"：去掉首尾空白、外层引号、以及 shell 里常见的
 * 包裹符号（`export REDIS_URL=` 这类前缀）。用户粘贴时几乎不会自己清理。
 */
export function parseConnectionUri(raw: string): ParseResult {
  let text = (raw ?? '').trim()
  if (!text) return { ok: false, error: { key: 'uri.pasteConnectionString' } }

  /*
   * 清洗顺序：先剥 `export REDIS_URL=` 前缀，再剥外层引号。
   * 反过来的话 `REDIS_URL="redis://…"` 的首字符不是引号，剥引号那步
   * 会整段跳过，引号残留在串里导致 URL 解析失败（实测踩到过）。
   */
  text = text.replace(/^(?:export\s+)?[A-Z0-9_]+\s*=\s*/i, '').trim()

  // 去掉引号包裹：'redis://…' / "redis://…" / `redis://…`
  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
  ]
  for (const [open, close] of quotePairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > 2) {
      text = text.slice(1, -1).trim()
      break
    }
  }

  // 允许省略协议：没有 `://` 时补默认协议，后续统一走 URL 解析
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  const normalized = hasScheme ? text : `redis://${text}`

  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    return { ok: false, error: { key: 'uri.unrecognizedConnectionStringFormat' } }
  }

  const scheme = url.protocol.replace(':', '').toLowerCase()
  if (scheme !== 'redis' && scheme !== 'rediss' && scheme !== 'memcached') {
    return { ok: false, error: { key: 'uri.unsupportedProtocol', params: { scheme } } }
  }

  const engine: CacheEngine = scheme === 'memcached' ? 'memcached' : 'redis'
  const host = url.hostname.trim()
  if (!host) return { ok: false, error: { key: 'uri.connectionStringMissingHostAddress' } }

  // 端口：URL 会把非法端口解析成空字符串，这里统一回到默认值
  const portRaw = url.port
  const port = portRaw
    ? Number(portRaw)
    : engine === 'memcached'
      ? DEFAULT_MEMCACHED_PORT
      : DEFAULT_REDIS_PORT
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: { key: 'uri.portOutOfRange', params: { port: portRaw } } }
  }

  /*
   * 用户名与密码都要 decodeURIComponent：
   * 密码里出现 @ : / 时必须转义，否则会被当成 URL 结构分隔符。
   * decode 失败（残缺的百分号转义）不视为致命错误 —— 直接按原样使用，
   * 比因为一个 % 就拒绝整串更好用。
   */
  const safeDecode = (value: string): string => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }

  const username = url.username ? safeDecode(url.username) : undefined
  const password = url.password ? safeDecode(url.password) : undefined

  /*
   * Memcached 没有认证与库的概念。带凭据或 /db 的连接串不能静默丢弃 ——
   * 用户会以为密码生效了，实际连上去就是无认证的裸实例；宁可明确拒绝。
   */
  if (engine === 'memcached') {
    if (username || password) return { ok: false, error: { key: 'uri.memcachedNoAuth' } }
    if (url.pathname && url.pathname !== '/') {
      return {
        ok: false,
        error: { key: 'uri.memcachedNoDatabase', params: { db: url.pathname.slice(1) } },
      }
    }
    return { ok: true, value: { engine, host, port, db: 0, tls: false } }
  }

  // 库号：取 pathname 的第一段；允许末尾带多余斜杠
  const pathMatch = url.pathname.match(/^\/(\d+)\/?$/)
  let db = 0
  if (url.pathname && url.pathname !== '/') {
    if (!pathMatch) {
      return {
        ok: false,
        error: {
          key: 'uri.invalidDatabaseNumber',
          params: { db: url.pathname.slice(1), max: MAX_DB },
        },
      }
    }
    db = Number(pathMatch[1])
    if (db < 0 || db > MAX_DB) {
      return { ok: false, error: { key: 'uri.databaseOutOfRange', params: { db, max: MAX_DB } } }
    }
  }

  return {
    ok: true,
    value: {
      engine,
      host,
      port,
      // 空用户名归一为 undefined，避免存进配置里出现 `username: ''` 这种噪音
      username: username || undefined,
      password: password || undefined,
      db,
      tls: scheme === 'rediss',
    },
  }
}

/**
 * 从任意文本里"捞"出第一个连接串。
 *
 * 场景：用户复制的是整行 Docker 日志或 `redis-cli -u redis://…` 命令，
 * 直接让解析器处理会失败。这里只做一件事 —— 找到 redis:// / rediss:// /
 * memcached:// 起始的那个 token。找不到就原样返回，交给 parseConnectionUri 报错。
 */
export function extractUriFromText(raw: string): string {
  const text = (raw ?? '').trim()
  const match = text.match(/((?:rediss?|memcached):\/\/[^\s"'`,;]+)/i)
  return match ? match[1]! : text
}

/* ---------------------------------------------------------------- 批量导入 */

/** 一次粘贴的上限：再多就不是"粘贴几行"而是误贴了整个文件 */
export const MAX_BATCH_URIS = 200

export interface BatchUriEntry {
  /** 原始文本中的行号（从 1 开始），报错时指回用户看到的那一行 */
  line: number
  raw: string
  result: ParseResult
}

export interface BatchParseResult {
  entries: BatchUriEntry[]
  valid: number
  invalid: number
  total: number
  tooMany: boolean
}

/** 取一行里的连接串 token：带协议的直接取 URI，裸 host 取第一个空白前的部分 */
function uriToken(line: string): string {
  const extracted = extractUriFromText(line)
  if (extracted !== line) return extracted
  return line.split(/\s+/)[0] ?? line
}

/**
 * 逐行解析连接串。
 *
 * 空行与 # 注释跳过；行内 URI 后面的说明文字由 extractUriFromText 截掉。
 * 非法行不中断整批 —— 保留行号与错误，让用户一次看到所有问题。
 */
export function parseConnectionUriBatch(raw: string): BatchParseResult {
  const candidates: Array<{ line: number; raw: string }> = []
  ;(raw ?? '').split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    candidates.push({ line: index + 1, raw: trimmed })
  })

  const tooMany = candidates.length > MAX_BATCH_URIS
  const entries: BatchUriEntry[] = candidates.slice(0, MAX_BATCH_URIS).map((item) => ({
    line: item.line,
    raw: item.raw,
    result: parseConnectionUri(uriToken(item.raw)),
  }))
  const valid = entries.filter((entry) => entry.result.ok).length

  return {
    entries,
    valid,
    invalid: entries.length - valid,
    total: entries.length,
    tooMany,
  }
}

