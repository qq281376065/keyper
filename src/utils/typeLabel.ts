import type { RedisValueType } from '@shared/types'

/**
 * 类型徽标的「单字符缩写」与「完整名称」。
 *
 * 背景：原先徽标直接用类型原文（STRING / HASH / STREAM），
 * 并设了 `min-width: 46px`。在 450px 宽的键栏里，一个 STRING/STREAM
 * 就占 52px，相当于吃掉键名的 6~7 个字符；而 SET 字面只需 33px，
 * 却被 min-width 强行撑到 46px —— 属于纯浪费。
 *
 * 改为 18px 圆形单字符后，宽度固定可预测、不随类型名长短变化。
 * 代价是单字母有歧义，因此**必须配 tooltip**（见 `typeLabel`），
 * 三处使用点都要挂 `v-tip`。
 *
 * 字母选型尽量贴合 Redis 自身惯例，而非随意取首字母：
 *   S  string   类型名首字母
 *   H  hash     类型名首字母
 *   L  list     类型名首字母
 *   E  set      取第二个字母，避开与 string 的 S 冲突
 *   Z  zset     有序集合的 Z（ZADD / ZRANGE 命令族）
 *   X  stream   stream 的命令全是 X 前缀（XADD / XRANGE / XLEN）
 *   ?  none     键已不存在（TTL = -2）
 *
 * 其中 X 最不直觉，但它是 Redis 生态里的既有约定：
 * 熟悉 XADD/XRANGE 的用户能直接对上，不熟悉的靠 tooltip 补足。
 */
const ABBR: Record<RedisValueType, string> = {
  string: 'S',
  hash: 'H',
  list: 'L',
  set: 'E',
  zset: 'Z',
  stream: 'X',
  none: '?',
}

/** 完整名称：tooltip 内容，带中文便于不认识缩写的用户 */
const LABEL: Record<RedisValueType, string> = {
  string: 'string · 字符串',
  hash: 'hash · 哈希',
  list: 'list · 列表',
  set: 'set · 集合',
  zset: 'zset · 有序集合',
  stream: 'stream · 流',
  none: '键不存在',
}

/**
 * 取徽标显示字符。
 *
 * 未知类型降级为类型名首字母而非抛错 ——
 * 将来 Redis 若新增类型（或服务端返回意料之外的值），
 * 界面不至于出现空白方块。
 */
export function typeAbbr(type: RedisValueType | string | undefined | null): string {
  if (!type) return '?'
  return ABBR[type as RedisValueType] ?? String(type).slice(0, 1).toUpperCase()
}

/** 取完整名称，用于 tooltip */
export function typeLabel(type: RedisValueType | string | undefined | null): string {
  if (!type) return '未知类型'
  return LABEL[type as RedisValueType] ?? String(type)
}
