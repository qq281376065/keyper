/**
 * 键空间相关的纯函数：主进程与 mock 共用同一份规则，
 * 避免两处各写一套导致聚合口径漂移（渲染层展示直接采信返回值）。
 */

/**
 * 键内存分析：键名 → 聚合前缀。
 *
 * 按项目统一的键分隔符 `:` 取前 depth 段（与树形视图 buildKeyTree 的
 * 分隔口径一致）；段数不足时（如无分隔符的键）返回完整键名 ——
 * 这类键自成一组，语义上等于「自己就是前缀」。
 */
export function memoryPrefixOf(key: string, depth: number): string {
  const parts = key.split(':')
  return parts.length <= depth ? key : parts.slice(0, depth).join(':')
}
/**
 * 键内存分析：结果桶数量上限。
 *
 * 内存分析的目的就是找内存大头，前 200 个前缀（按内存降序）已覆盖
 * 实际排查场景；无界返回会让千前缀实例的 IPC payload 与表格渲染失重。
 * 截断时 MemoryAnalysis.bucketsTruncated 置真，由界面提示。
 */
export const MEMORY_BUCKET_LIMIT = 200