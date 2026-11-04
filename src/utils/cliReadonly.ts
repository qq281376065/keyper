import { REDIS_COMMANDS } from '@shared/redis-commands'

/**
 * CLI 命令是否只读。
 *
 * 以 redis-doc 目录的 readonly 标记为主；容器命令（CLIENT / CONFIG 等）
 * 没有统一的 readonly 标记，保留原有手写集合与少量子命令白名单兜底。
 */

const LEGACY_READONLY = new Set([
  'PING', 'ECHO', 'HELLO',
  'GET', 'MGET', 'STRLEN', 'GETRANGE', 'GETBIT', 'SUBSTR',
  'EXISTS', 'TYPE', 'TTL', 'PTTL', 'KEYS', 'SCAN', 'DUMP', 'RANDOMKEY',
  'OBJECT', 'MEMORY', 'INFO', 'DBSIZE', 'TIME', 'LASTSAVE', 'LOLWUT', 'COMMAND',
  'CLIENT', 'CLUSTER', 'SLOWLOG', 'LATENCY', 'MODULE',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HSTRLEN', 'HEXISTS', 'HRANDFIELD', 'HSCAN',
  'LRANGE', 'LINDEX', 'LLEN', 'LPOS',
  'SMEMBERS', 'SISMEMBER', 'SMISMEMBER', 'SCARD', 'SRANDMEMBER', 'SINTER', 'SINTERCARD', 'SUNION', 'SUNIONCARD', 'SDIFF', 'SDIFFCARD', 'SSCAN',
  'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE', 'ZREVRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGEBYLEX',
  'ZSCORE', 'ZMSCORE', 'ZCARD', 'ZCOUNT', 'ZLEXCOUNT', 'ZRANK', 'ZREVRANK', 'ZRANDMEMBER',
  'GEOPOS', 'GEODIST', 'GEOHASH', 'GEOSEARCH',
  'BITCOUNT', 'BITPOS', 'BITFIELD_RO',
  'XLEN', 'XRANGE', 'XREVRANGE', 'XREAD', 'XINFO',
])

/** 目录里没有 readonly 标记、但只读的容器子命令 */
const READONLY_SUBCOMMANDS = new Set([
  'CLIENT LIST',
  'CLIENT INFO',
  'CLIENT GETNAME',
  'CONFIG GET',
  'CONFIG HELP',
  'COMMAND DOCS',
  'COMMAND INFO',
  'COMMAND GETKEYS',
])

const READONLY_BY_NAME = new Map(REDIS_COMMANDS.map((item) => [item.name, item.readonly]))

export function isReadonlyCliCommand(command: string): boolean {
  const parts = command.trim().split(/\s+/).filter(Boolean)
  const head = parts[0]?.toUpperCase() ?? ''
  if (!head) return true
  const full = parts.length > 1 ? `${head} ${parts[1].toUpperCase()}` : head
  if (READONLY_SUBCOMMANDS.has(full)) return true
  if (LEGACY_READONLY.has(head)) return true
  return READONLY_BY_NAME.get(full) ?? READONLY_BY_NAME.get(head) ?? false
}
