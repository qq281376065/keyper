import { useEffect, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { useSessionStore } from '@/hooks/useSessionStore'
import type { MemoryAnalysis, MemoryBucket } from '@shared/types'

/** 每页行数：200 桶上限内分批展示，避免长表一次性铺满概览页 */
const PAGE_SIZE = 20

/**
 * 键内存分析卡片：SCAN 全库 + MEMORY USAGE，按前缀聚合出内存分布。
 *
 * 与慢日志 / Pub/Sub 的数据策略刻意不同 —— **不自动加载**：
 * 逐键探测是浏览路径上最重的读操作（百万键实例分钟级），
 * 用户没表达意图就自动扫一遍，连接成功的第一眼会变成卡顿。
 * 切换前缀粒度（depth）时若已有结果则自动重算 —— 调整粒度
 * 本身就是继续分析的表达，再点一次按钮是多余动作。
 */
export function MemoryCard() {
  const { state, activeConnection } = useRedis()
  useObservable(useSessionStore())

  const [analysis, setAnalysis] = useState<MemoryAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [depth, setDepth] = useState(1)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const connected = activeConnection?.status === 'connected'
  const activeId = state.activeId

  async function runAnalysis(): Promise<void> {
    if (!activeId || loading) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.redis.memoryAnalysis(activeId, depth)
      if (!res.ok) throw new Error(res.error)
      setAnalysis(res.data)
      /* 新结果从第一页看起（切粒度自动重算同样走这里） */
      setVisibleCount(PAGE_SIZE)
    } catch (err) {
      setError(err instanceof Error ? err.message : '键内存分析失败')
    } finally {
      setLoading(false)
    }
  }

  /*
   * 连接切换只清结果、不自动重扫 —— 与「不自动加载」的策略一致。
   */
  useEffect(() => {
    setAnalysis(null)
    setError(null)
    setDepth(1)
    setVisibleCount(PAGE_SIZE)
    if (!connected) setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, connected])

  /*
   * depth 切换在已有结果时自动重算。
   * 用 ref 记录上一次 depth，避免初次挂载与连接重置也触发。
   */
  const [prevDepth, setPrevDepth] = useState(depth)
  useEffect(() => {
    if (prevDepth !== depth) {
      setPrevDepth(depth)
      if (analysis && connected && !loading) void runAnalysis()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth])

  const visibleBuckets = analysis?.buckets.slice(0, visibleCount) ?? []
  const remaining = Math.max(0, (analysis?.buckets.length ?? 0) - visibleCount)

  /** 字节人性化：B / KB / MB / GB（1024 进制），占比列保留 1 位小数 */
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  }

  /** 占总量百分比；空库（总量 0）防除零 */
  function pctOf(bucket: MemoryBucket): number {
    const total = analysis?.totalBytes ?? 0
    return total > 0 ? (bucket.bytes / total) * 100 : 0
  }

  return (
    <section className="mem-card s-memory-card">
      <header className="mem-head">
        <h3 className="mem-title">
          <DialogIcon name="memory" size={14} className="mem-icon" />
          <span>键内存分析</span>
        </h3>
        {/* 前缀粒度：并列选项组，选中态高亮（分段选择器，按约定不加图标） */}
        {connected ? (
          <div className="mem-depth">
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                className={`mem-depth-btn${depth === n ? ' on' : ''}`}
                {...tipProps(`按键名前 ${n} 段聚合`)}
                onClick={() => setDepth(n)}
              >
                {n} 段
              </button>
            ))}
          </div>
        ) : null}
        {connected ? (
          <button className="mem-run" disabled={loading} onClick={() => void runAnalysis()}>
            <DialogIcon name="memory" size={12} className="ti" />
            {loading ? '分析中…' : analysis ? '重新分析' : '开始分析'}
          </button>
        ) : null}
      </header>

      <p className="mem-hint">
        按前缀聚合各键组的内存占用（MEMORY USAGE，集合类为采样近似值）；逐键探测较重，扫描上限 10000 个键，结果保留内存前 200 的前缀
      </p>

      {error ? (
        <p className="mem-error">{error}</p>
      ) : analysis ? (
        <>
          {analysis.truncated ? (
            <p className="mem-trunc">键数超过扫描上限，仅统计前 {analysis.scanned} 个键 —— 结果为近似分布</p>
          ) : null}
          {analysis.bucketsTruncated ? <p className="mem-trunc">前缀超过 200 个，仅保留内存占用前 200 的前缀</p> : null}

          {analysis.buckets.length ? (
            <table className="mem-table">
              <thead>
                <tr>
                  <th className="col-prefix">前缀</th>
                  <th className="col-keys">键数</th>
                  <th className="col-bytes">内存</th>
                  <th className="col-pct">占比</th>
                </tr>
              </thead>
              <tbody>
                {visibleBuckets.map((bucket) => (
                  <tr key={bucket.prefix}>
                    <td {...tipProps(bucket.prefix)} className="mono col-prefix">
                      {bucket.prefix}
                    </td>
                    <td className="mono col-keys">{bucket.keys}</td>
                    <td className="mono col-bytes">{formatBytes(bucket.bytes)}</td>
                    <td className="col-pct">
                      <span className="mem-bar">
                        <span className="mem-bar-fill" style={{ width: `${pctOf(bucket)}%` }} />
                      </span>
                      <span className="mono mem-pct-text">{pctOf(bucket).toFixed(1)}%</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="mem-empty">当前库没有键</div>
          )}

          {remaining > 0 ? (
            <button
              className="mem-more"
              {...tipProps(`再显示 ${Math.min(PAGE_SIZE, remaining)} 行`)}
              onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
            >
              <DialogIcon name="arrow-down" size={12} className="ti" />
              加载更多（还有 {remaining} 个前缀）
            </button>
          ) : null}

          {analysis.buckets.length ? (
            <p className="mem-summary mono">
              共 {analysis.buckets.length} 个前缀 · {analysis.scanned} 个键 · 总内存 {formatBytes(analysis.totalBytes)}
            </p>
          ) : null}
        </>
      ) : (
        <div className="mem-empty">{loading ? '正在分析…' : '点击「开始分析」统计当前库的内存分布'}</div>
      )}
    </section>
  )
}

export default MemoryCard
