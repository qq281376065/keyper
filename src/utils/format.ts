/** 展示层通用格式化工具 */
import { t } from '@shared/i18n'

/** 把 TTL 秒数格式化为紧凑可读文本（永久 / 已过期随界面语言） */
export function formatTtl(ttl: number): string {
  if (ttl === -1) return t('common.noExpiration')
  if (ttl === -2) return t('ttl.expired')
  if (ttl >= 86400) return `${Math.floor(ttl / 86400)}d${Math.floor((ttl % 86400) / 3600)}h`
  if (ttl >= 3600) return `${Math.floor(ttl / 3600)}h${Math.floor((ttl % 3600) / 60)}m`
  if (ttl >= 60) return `${Math.floor(ttl / 60)}m${ttl % 60}s`
  return `${ttl}s`
}

/** TTL 语义色调：forever=永久（弱化）/ urgent=即将过期（警示） */
export function ttlTone(ttl: number): '' | 'forever' | 'urgent' {
  if (ttl === -1) return 'forever'
  if (ttl >= 0 && ttl <= 60) return 'urgent'
  return ''
}

/**
 * 把「扫描时刻的 TTL」折算成当前剩余秒数。
 * 负值（-1 永久 / -2 已过期）原样返回；ttlAt 由渲染层在收到数据时打戳。
 */
export function remainingTtl(ttl: number, ttlAt: number, now = Date.now()): number {
  if (ttl < 0) return ttl
  const elapsed = Math.max(0, Math.floor((now - ttlAt) / 1000))
  return Math.max(0, ttl - elapsed)
}

/** 读取渲染层附加的扫描时间戳（IPC 的 RedisKeyItem 本身不含该字段） */
export function ttlAtOf(item: object): number | undefined {
  return (item as { ttlAt?: number }).ttlAt
}

/** 字节数格式化 */
/**
 * 字符串的 UTF-8 字节数。
 *
 * 为什么不用 `new Blob([s]).size`：Blob 是 DOM 容器对象，构造要经过
 * 一轮内存拷贝与内部登记。实测（CPU profile）在一次「点开 11KB JSON 键」
 * 的操作里，Blob 构造占掉了 **77% 的 CPU 时间（4 秒）** —— 因为它被放在
 * 渲染路径上对每个元素调用，且随重渲染重复执行。
 *
 * 这里走 TextEncoder：同样给出 UTF-8 字节数，但是纯计算、无对象分配
 * （编码器实例惰性创建并复用）。对 1MB 文本约 2–3ms，比 Blob 快两个数量级。
 */
let encoder: TextEncoder | null = null
export function utf8Bytes(text: string): number {
  if (!text) return 0
  /* 纯 ASCII 快路径：长度即字节数，连 encoder 都不用碰 */
  if (!/[-￿]/.test(text)) return text.length
  encoder ??= new TextEncoder()
  return encoder.encode(text).length
}

export function formatBytes(bytes?: number): string {
  if (bytes == null || Number.isNaN(bytes)) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * JSON 美化。
 * 仅在文本确实是合法 JSON 时返回缩进后的结果，否则原样返回并标记 ok=false，
 * 避免把普通字符串误格式化成不可读的样子。
 */
export function prettyJson(text: string, indent = 2): { ok: boolean; text: string } {
  const trimmed = text.trim()
  const looksLikeJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  if (!looksLikeJson) return { ok: false, text }

  try {
    return { ok: true, text: JSON.stringify(JSON.parse(trimmed), null, indent) }
  } catch {
    return { ok: false, text }
  }
}

/** 单行预览：把多行文本压成一行，用于表格等紧凑场景 */
export function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
