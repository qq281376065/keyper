import type {
  CacheConnectionConfig,
  ConnectionExportOptions,
  ConnectionImportConflict,
  ConnectionImportIssue,
  ConnectionImportPreviewItem,
  ConnectionImportSummary,
  MemcachedConnectionConfig,
  RedisConnectionConfig,
  SshConfig,
  SshHop,
} from './types'
import { t } from './i18n'

/**
 * 连接配置导入导出的纯逻辑。
 *
 * 放在 shared 而不是 electron/services：浏览器预览的 mock 与单元测试
 * 都要跑同一套解析/合并规则。文件 IO 与一次性令牌留在主进程
 * （见 electron/services/connection-transfer.ts）。
 *
 * 与内部 connections.json 刻意分开：
 *   · 内部文件是数组，密码是与会话密钥绑定的 enc2: 密文，换机器解不开；
 *   · 传输文件带格式头与版本号，凭据默认剥离，可安全地跨机器搬运。
 */

export const TRANSFER_FORMAT = 'keyper.connections'
export const TRANSFER_VERSION = 1
export const MAX_TRANSFER_CONNECTIONS = 500
export const MAX_TRANSFER_FILE_BYTES = 5 * 1024 * 1024
const MAX_SSH_HOPS = 10

export interface ConnectionTransferFile {
  format: typeof TRANSFER_FORMAT
  version: number
  exportedAt: string
  appVersion: string
  includesCredentials: boolean
  connections: CacheConnectionConfig[]
}

/* ---------------------------------------------------------------- 导出 */

/**
 * 逐字段白名单构造，绝不整对象展开。
 *
 * 展开会把 pinned / credentialError 之类运行时字段、以及未来新增的
 * 敏感字段一并写进文件；白名单的漏写最多丢功能，黑名单的漏删会泄密。
 */
function exportSsh(ssh: SshConfig | undefined, includeCredentials: boolean): SshConfig | undefined {
  if (!ssh) return undefined
  const hops: SshHop[] | undefined = ssh.hops?.length
    ? ssh.hops.map((hop) => ({
        host: hop.host,
        port: hop.port,
        username: hop.username,
        authMethod: hop.authMethod,
        ...(includeCredentials && hop.password ? { password: hop.password } : {}),
        ...(includeCredentials && hop.privateKey ? { privateKey: hop.privateKey } : {}),
        ...(includeCredentials && hop.passphrase ? { passphrase: hop.passphrase } : {}),
      }))
    : undefined

  return {
    host: ssh.host,
    port: ssh.port,
    username: ssh.username,
    authMethod: ssh.authMethod,
    ...(ssh.targetFromRemote !== undefined ? { targetFromRemote: ssh.targetFromRemote } : {}),
    ...(includeCredentials && ssh.password ? { password: ssh.password } : {}),
    ...(includeCredentials && ssh.privateKey ? { privateKey: ssh.privateKey } : {}),
    ...(includeCredentials && ssh.passphrase ? { passphrase: ssh.passphrase } : {}),
    ...(hops ? { hops } : {}),
  }
}

function exportConfig(item: CacheConnectionConfig, includeCredentials: boolean): CacheConnectionConfig {
  const base = {
    id: item.id,
    name: item.name,
    host: item.host,
    port: item.port,
  }
  const ssh = exportSsh(item.ssh, includeCredentials)
  const sshFields = {
    /* 保存了隧道但临时关闭：必须显式写 false，否则导入端会按「有 ssh 即启用」重新打开 */
    ...(item.sshEnabled ? { sshEnabled: true } : ssh ? { sshEnabled: false } : {}),
    ...(ssh ? { ssh } : {}),
  }

  if (item.engine === 'memcached') {
    return {
      ...base,
      engine: 'memcached',
      ...(item.poolSize !== undefined ? { poolSize: item.poolSize } : {}),
      ...sshFields,
    } satisfies MemcachedConnectionConfig
  }

  return {
    ...base,
    engine: 'redis',
    ...(item.username ? { username: item.username } : {}),
    ...(includeCredentials && item.password ? { password: item.password } : {}),
    db: item.db,
    ...(item.tls ? { tls: true } : {}),
    ...sshFields,
  } satisfies RedisConnectionConfig
}

export function buildExportPayload(
  list: CacheConnectionConfig[],
  options: ConnectionExportOptions,
  appVersion: string,
): { file: ConnectionTransferFile; missingCredentials: number } {
  return {
    file: {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion,
      includesCredentials: options.includeCredentials,
      connections: list.map((item) => exportConfig(item, options.includeCredentials)),
    },
    /* 密文解不开的条目：即使勾选「包含凭据」也只能导出空密码，需要提示用户 */
    missingCredentials: list.filter((item) => !!item.credentialError).length,
  }
}

/* ---------------------------------------------------------------- 解析与校验 */

export interface ParsedTransfer {
  formatVersion: number
  exportedAt?: string
  appVersion?: string
  /** 以实际解析出的字段为准，不盲信文件头的声明 */
  includesCredentials: boolean
  total: number
  configs: CacheConnectionConfig[]
  issues: ConnectionImportIssue[]
}

class ItemError extends Error {}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function integer(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return undefined
  }
  return value
}

let idCounter = 0

/** 导入时补 ID；同一进程内保证唯一，不依赖 crypto 以便浏览器 mock 复用 */
function makeId(): string {
  idCounter = (idCounter + 1) % 1_000_000
  return `conn-${Date.now().toString(36)}-${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function parseHops(raw: unknown): SshHop[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new ItemError(t('connectionTransfer.invalidSsh'))
  if (raw.length > MAX_SSH_HOPS) throw new ItemError(t('connectionTransfer.invalidSsh'))
  if (!raw.length) return undefined

  const hops: SshHop[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') throw new ItemError(t('connectionTransfer.invalidSsh'))
    const hop = entry as Record<string, unknown>
    const host = text(hop.host)?.trim()
    const username = text(hop.username)?.trim()
    if (!host) throw new ItemError(t('connectionTransfer.invalidSsh'))
    if (!username) throw new ItemError(t('connectionTransfer.invalidSsh'))
    const port = hop.port === undefined ? 22 : integer(hop.port, 1, 65535)
    if (port === undefined) throw new ItemError(t('connectionTransfer.invalidSsh'))
    const authMethod = hop.authMethod === 'key' ? 'key' : hop.authMethod === 'password' ? 'password' : undefined
    if (!authMethod) throw new ItemError(t('connectionTransfer.invalidSsh'))

    hops.push({
      host,
      port,
      username,
      authMethod,
      ...(text(hop.password) ? { password: text(hop.password) } : {}),
      ...(text(hop.privateKey) ? { privateKey: text(hop.privateKey) } : {}),
      ...(text(hop.passphrase) ? { passphrase: text(hop.passphrase) } : {}),
    })
  }
  return hops
}

function parseSsh(raw: unknown): SshConfig | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ItemError(t('connectionTransfer.invalidSsh'))
  }
  const source = raw as Record<string, unknown>
  const host = text(source.host)?.trim()
  const username = text(source.username)?.trim()
  if (!host) throw new ItemError(t('connectionTransfer.invalidSsh'))
  if (!username) throw new ItemError(t('connectionTransfer.invalidSsh'))
  const port = source.port === undefined ? 22 : integer(source.port, 1, 65535)
  if (port === undefined) throw new ItemError(t('connectionTransfer.invalidSsh'))
  const authMethod = source.authMethod === 'key' ? 'key' : source.authMethod === 'password' ? 'password' : undefined
  if (!authMethod) throw new ItemError(t('connectionTransfer.invalidSsh'))
  const hops = parseHops(source.hops)

  return {
    host,
    port,
    username,
    authMethod,
    ...(text(source.password) ? { password: text(source.password) } : {}),
    ...(text(source.privateKey) ? { privateKey: text(source.privateKey) } : {}),
    ...(text(source.passphrase) ? { passphrase: text(source.passphrase) } : {}),
    ...(typeof source.targetFromRemote === 'boolean' ? { targetFromRemote: source.targetFromRemote } : {}),
    ...(hops ? { hops } : {}),
  }
}

function normalizeConfig(raw: unknown, index: number): CacheConnectionConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ItemError(t('connectionTransfer.invalidItem', { index: index + 1 }))
  }
  const source = raw as Record<string, unknown>
  const engineRaw = source.engine
  /* 旧配置没有 engine 字段；传输格式虽总会写入，手写文件仍按 Redis 兜底 */
  const engine = engineRaw === undefined || engineRaw === 'redis' ? 'redis' : engineRaw === 'memcached' ? 'memcached' : null
  if (!engine) throw new ItemError(t('connectionTransfer.invalidEngine'))

  const host = text(source.host)?.trim()
  if (!host) throw new ItemError(t('connectionTransfer.missingHost'))
  const port = integer(source.port, 1, 65535)
  if (port === undefined) throw new ItemError(t('connectionTransfer.invalidPort'))

  const name = text(source.name)?.trim() || `${host}:${port}`
  const id = text(source.id)?.trim() || makeId()
  const ssh = parseSsh(source.ssh)
  const sshEnabled = source.sshEnabled === undefined ? !!ssh : source.sshEnabled === true

  if (engine === 'memcached') {
    const poolSizeRaw = source.poolSize
    const poolSize = poolSizeRaw === undefined ? undefined : integer(poolSizeRaw, 1, 64)
    if (poolSizeRaw !== undefined && poolSize === undefined) {
      throw new ItemError(t('connectionTransfer.invalidPoolSize'))
    }
    return {
      id,
      engine: 'memcached',
      name,
      host,
      port,
      ...(poolSize !== undefined ? { poolSize } : {}),
      ...(ssh ? { ssh } : {}),
      ...(sshEnabled ? { sshEnabled: true } : {}),
    }
  }

  const dbRaw = source.db
  const db = dbRaw === undefined ? 0 : integer(dbRaw, 0, 15)
  if (db === undefined) throw new ItemError(t('connectionTransfer.invalidDb'))
  const username = text(source.username)?.trim()
  const password = text(source.password)

  return {
    id,
    engine: 'redis',
    name,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    db,
    ...(source.tls === true ? { tls: true } : {}),
    ...(ssh ? { ssh } : {}),
    ...(sshEnabled ? { sshEnabled: true } : {}),
  }
}

/** 与导出互逆：把文件文本解析成配置列表；文件级错误直接抛，条目级错误进 issues */
export function parseTransferText(raw: string): ParsedTransfer {
  const textWithoutBom = raw.replace(/^\uFEFF/, '')
  if (!textWithoutBom.trim()) throw new Error(t('connectionTransfer.emptyFile'))

  let root: unknown
  try {
    root = JSON.parse(textWithoutBom)
  } catch {
    throw new Error(t('connectionTransfer.invalidJson'))
  }

  /* 内部 connections.json 是裸数组：误导入会二次加密密文，必须明确拒绝 */
  if (Array.isArray(root)) throw new Error(t('connectionTransfer.internalConfigFile'))
  if (!root || typeof root !== 'object') throw new Error(t('connectionTransfer.formatNotKeyper'))

  const file = root as Record<string, unknown>
  if (file.format !== TRANSFER_FORMAT) throw new Error(t('connectionTransfer.formatNotKeyper'))
  const version = integer(file.version, 1, Number.MAX_SAFE_INTEGER)
  if (version === undefined || version > TRANSFER_VERSION) {
    throw new Error(
      t('connectionTransfer.unsupportedVersion', { version: String(file.version ?? '-') }),
    )
  }

  if (!Array.isArray(file.connections)) throw new Error(t('connectionTransfer.formatNotKeyper'))
  if (!file.connections.length) throw new Error(t('connectionTransfer.noConnections'))
  if (file.connections.length > MAX_TRANSFER_CONNECTIONS) {
    throw new Error(
      t('connectionTransfer.tooManyConnections', {
        max: MAX_TRANSFER_CONNECTIONS,
        count: file.connections.length,
      }),
    )
  }

  const configs: CacheConnectionConfig[] = []
  const issues: ConnectionImportIssue[] = []
  const seenIds = new Set<string>()

  file.connections.forEach((entry, index) => {
    try {
      const config = normalizeConfig(entry, index)
      if (seenIds.has(config.id)) throw new ItemError(t('connectionTransfer.duplicateId'))
      seenIds.add(config.id)
      configs.push(config)
    } catch (error) {
      issues.push({
        index,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

  return {
    formatVersion: version,
    exportedAt: text(file.exportedAt),
    appVersion: text(file.appVersion),
    includesCredentials: configs.some(hasAnyCredential),
    total: file.connections.length,
    configs,
    issues,
  }
}

function sshHasCredential(ssh: SshConfig | undefined): boolean {
  if (!ssh) return false
  if (ssh.password || ssh.passphrase || ssh.privateKey) return true
  return (ssh.hops ?? []).some((hop) => !!hop.password || !!hop.passphrase || !!hop.privateKey)
}

function hasAnyCredential(config: CacheConnectionConfig): boolean {
  if (config.engine === 'redis' && !!config.password) return true
  return sshHasCredential(config.ssh)
}

/* ---------------------------------------------------------------- 预览 */

export interface PreviewContext {
  existing: CacheConnectionConfig[]
  /** 按文件条目里的 ID 判断是否处于连接中 */
  isConnected: (id: string) => boolean
}

export function buildPreviewItems(
  configs: CacheConnectionConfig[],
  context: PreviewContext,
): ConnectionImportPreviewItem[] {
  const existingById = new Map(context.existing.map((item) => [item.id, item]))
  const existingNames = new Set(context.existing.map((item) => item.name))

  return configs.map((config, index) => {
    let conflict: ConnectionImportConflict = 'none'
    if (existingById.has(config.id)) conflict = 'id'
    else if (existingNames.has(config.name)) conflict = 'name'

    return {
      index,
      engine: config.engine,
      name: config.name,
      host: config.host,
      port: config.port,
      ...(config.engine === 'redis'
        ? {
            ...(config.username ? { username: config.username } : {}),
            db: config.db,
            ...(config.tls ? { tls: true } : {}),
          }
        : { ...(config.poolSize !== undefined ? { poolSize: config.poolSize } : {}) }),
      sshEnabled: !!config.sshEnabled,
      ...(config.ssh ? { sshHost: config.ssh.host } : {}),
      ...(config.ssh?.hops?.length ? { sshHopCount: config.ssh.hops.length } : {}),
      hasPassword: config.engine === 'redis' && !!config.password,
      hasSshCredential: sshHasCredential(config.ssh),
      conflict,
      connected: conflict === 'id' && context.isConnected(config.id),
    }
  })
}

/* ---------------------------------------------------------------- 合并 */

export interface MergeOptions {
  overwrite: boolean
  connectedIds: ReadonlySet<string>
}

export interface MergeResult {
  next: CacheConnectionConfig[]
  summary: ConnectionImportSummary
  skippedConnected: string[]
}

function uniqueId(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) return candidate
  let next = makeId()
  while (used.has(next)) next = makeId()
  return next
}

function uniqueName(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) return candidate
  let n = 2
  while (used.has(`${candidate} (${n})`)) n += 1
  return `${candidate} (${n})`
}

/**
 * 把导入项合入现有列表。
 *
 * 覆盖只按 ID 匹配：名称无法唯一标识一条配置，按名称覆盖会误伤
 * 用户手改过名字的另一条连接。已连接项一律跳过 —— 覆盖磁盘配置
 * 并不会重建内存里的客户端，界面显示新地址、会话仍连旧实例，
 * 这种"看起来更新了其实没有"的状态比直接拒绝更危险。
 */
export function mergeImported(
  existing: CacheConnectionConfig[],
  incoming: CacheConnectionConfig[],
  options: MergeOptions,
): MergeResult {
  const next = [...existing]
  const usedIds = new Set(next.map((item) => item.id))
  const usedNames = new Set(next.map((item) => item.name))
  const byId = new Map(next.map((item) => [item.id, item]))
  const summary: ConnectionImportSummary = { imported: 0, overwritten: 0, skipped: 0 }
  const skippedConnected: string[] = []

  for (const item of incoming) {
    const existingItem = byId.get(item.id)

    if (options.overwrite && existingItem) {
      if (options.connectedIds.has(item.id)) {
        summary.skipped += 1
        skippedConnected.push(existingItem.name)
        continue
      }
      const index = next.findIndex((entry) => entry.id === item.id)
      const replaced: CacheConnectionConfig = {
        ...item,
        id: item.id,
        ...(existingItem.pinned ? { pinned: true } : {}),
      }
      next[index] = replaced
      byId.set(item.id, replaced)
      summary.overwritten += 1
      continue
    }

    const id = uniqueId(item.id, usedIds)
    const name = uniqueName(item.name, usedNames)
    const added: CacheConnectionConfig = { ...item, id, name }
    next.push(added)
    usedIds.add(id)
    usedNames.add(name)
    byId.set(id, added)
    summary.imported += 1
  }

  return { next, summary, skippedConnected }
}
