/**
 * Redis 服务端能力探测。
 *
 * 独立成文件的原因：服务端特性存在明显的版本分界（如 7.4 才引入 hash 字段级 TTL，
 * 由 HEXPIRE / HTTL / HPERSIST 提供），后续接入 sentinel / cluster 或更多新特性时，
 * 只需在这里追加探测项，不必散落到各个组件里判断。
 */

export interface RedisVersion {
  major: number
  minor: number
  patch: number
  /** 原始版本串，便于排障时展示 */
  raw: string
}

/** 服务端能力开关 */
export interface ServerCapabilities {
  version: RedisVersion | null
  /**
   * hash 字段级 TTL（HEXPIRE / HTTL / HPERSIST）。
   * 需 Redis >= 7.4；版本未知时保守关闭 —— 这些命令在低版本上不是降级可用，
   * 而是直接返回 "unknown command" 错误，展示出来只会变成一列空数据。
   */
  hashFieldTtl: boolean
  /** set 成员级 TTL（SHEXPIRE / STTL），与 hash 同批引入 */
  setMemberTtl: boolean
  /** 版本是否成功解析（false 表示拿不到版本，能力一律按不支持处理） */
  versionKnown: boolean
}

/**
 * 解析形如 "7.4.0" / "7.2.4" / "6.2.14" 的版本串。
 * 兼容带后缀的构建串（如 "7.4.0-rc1"、"255.255.255"），只取前三段数字。
 */
export function parseRedisVersion(raw?: string | null): RedisVersion | null {
  if (!raw) return null
  const matched = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw)
  if (!matched) return null
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: matched[3] ? Number(matched[3]) : 0,
    raw,
  }
}

/** 版本比较：a >= b 时返回 true */
export function versionAtLeast(version: RedisVersion | null, major: number, minor: number): boolean {
  if (!version) return false
  if (version.major !== major) return version.major > major
  return version.minor >= minor
}

/** 依据版本推导可用能力 */
export function resolveCapabilities(versionText?: string | null): ServerCapabilities {
  const version = parseRedisVersion(versionText)
  const fieldTtl = versionAtLeast(version, 7, 4)
  return {
    version,
    versionKnown: version !== null,
    hashFieldTtl: fieldTtl,
    setMemberTtl: fieldTtl,
  }
}

/** 用于界面提示的版本描述 */
export function describeVersion(capabilities: ServerCapabilities): string {
  return capabilities.version ? capabilities.version.raw : '未知'
}
