import { useEffect, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
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
  const { t } = useI18n()
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
      setError(err instanceof Error ? err.message : t('memoryCard.keyMemoryAnalysisFailed'))
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
          <span>{t('common.keyMemoryAnalysis')}</span>
        </h3>
        {/* 前缀粒度：并列选项组，选中态高亮（分段选择器，按约定不加图标） */}
        {connected ? (
          <div className="mem-depth">
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                className={`mem-depth-btn${depth === n ? ' on' : ''}`}
                {...tipProps(t('memoryCard.aggregateFirstCountSegmentsKey', { count: n }))}
                onClick={() => setDepth(n)}
              >
                {t('memoryCard.countSections', { count: n })}
              </button>
            ))}
          </div>
        ) : null}
        {connected ? (
          <button className="mem-run" disabled={loading} onClick={() => void runAnalysis()}>
            <DialogIcon name="memory" size={12} className="ti" />
            {loading ? t('memoryCard.analyzingAction') : analysis ? t('memoryCard.reAnalyze') : t('memoryCard.startAnalysis')}
          </button>
        ) : null}
      </header>

      <p className="mem-hint">
        {t('memoryCard.aggregatesMemoryUsageKeyGroup')}
      </p>

      {error ? (
        <p className="mem-error">{error}</p>
      ) : analysis ? (
        <>
          {analysis.truncated ? (
            <p className="mem-trunc">{t('memoryCard.keyCountExceedsScanLimit', { count: analysis.scanned })}</p>
          ) : null}
          {analysis.bucketsTruncated ? <p className="mem-trunc">{t('memoryCard.moreThan200PrefixesOnly')}</p> : null}

          {analysis.buckets.length ? (
            <table className="mem-table">
              <thead>
                <tr>
                  <th className="col-prefix">{t('memoryCard.prefix')}</th>
                  <th className="col-keys">{t('memoryCard.keys')}</th>
                  <th className="col-bytes">{t('common.memory')}</th>
                  <th className="col-pct">{t('memoryCard.share')}</th>
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
            <div className="mem-empty">{t('memoryCard.currentDatabaseNoKeys')}</div>
          )}

          {remaining > 0 ? (
            <button
              className="mem-more"
              {...tipProps(t('memoryCard.showCountMoreLines', { count: Math.min(PAGE_SIZE, remaining) }))}
              onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
            >
              <DialogIcon name="arrow-down" size={12} className="ti" />
              {t('memoryCard.loadMore', { count: remaining })}
            </button>
          ) : null}

          {analysis.buckets.length ? (
            <p className="mem-summary mono">
              {t('memoryCard.prefixesKeysBytesTotalMemory', {
                prefixes: analysis.buckets.length,
                keys: analysis.scanned,
                bytes: formatBytes(analysis.totalBytes),
              })}
            </p>
          ) : null}
        </>
      ) : (
        <div className="mem-empty">{loading ? t('memoryCard.analyzingHint') : t('memoryCard.clickStartAnalysisProfileMemory')}</div>
      )}
    </section>
  )
}

export default MemoryCard
