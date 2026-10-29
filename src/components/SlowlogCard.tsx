import { useEffect, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { useSessionStore } from '@/hooks/useSessionStore'
import type { SlowlogOverview } from '@shared/types'

const SLOWLOG_FETCH_COUNT = 10

/**
 * 服务端慢查询日志卡片（SLOWLOG）。
 *
 * 数据策略与详情卡片一致：连接成功后自动拉一次，
 * 之后只随概览页的统一「刷新」按钮重取 ——
 * 慢日志不是秒级仪表盘，自动轮询反而 distracting。
 */
export function SlowlogCard({ registerRefresh }: { registerRefresh?: (fn: () => Promise<void>) => void }) {
  const { state, activeConnection, notify } = useRedis()
  useObservable(useSessionStore())

  const [overview, setOverview] = useState<SlowlogOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 防连击：清空是即时动作，确认层对这种操作过重 */
  const [resetting, setResetting] = useState(false)

  const connected = activeConnection?.status === 'connected'
  const activeId = state.activeId

  async function loadSlowlog(): Promise<void> {
    if (!activeId) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.redis.slowlog(activeId, SLOWLOG_FETCH_COUNT)
      if (!res.ok) throw new Error(res.error)
      setOverview(res.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取慢查询日志失败')
    } finally {
      setLoading(false)
    }
  }

  /* 供父组件（概览页统一刷新）调用 */
  useEffect(() => {
    registerRefresh?.(loadSlowlog)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerRefresh])

  async function resetSlowlog(): Promise<void> {
    if (!activeId || resetting) return
    setResetting(true)
    try {
      const res = await api.redis.slowlogReset(activeId)
      if (!res.ok) throw new Error(res.error)
      await loadSlowlog()
      notify('ok', '慢查询日志已清空')
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '清空慢查询日志失败')
    } finally {
      setResetting(false)
    }
  }

  /* 连接维度双判定：防「串实例」与「恢复态误拉」 */
  useEffect(() => {
    setOverview(null)
    setError(null)
    if (activeId && connected) void loadSlowlog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, connected])

  const entries = overview?.entries ?? []

  /** 耗时：微秒起步（SLOWLOG 原始单位），ms / s 两档展示 */
  function formatDuration(micros: number): string {
    if (micros < 1000) return `${micros}μs`
    if (micros < 1_000_000) return `${(micros / 1000).toFixed(micros < 100_000 ? 1 : 0)}ms`
    return `${(micros / 1_000_000).toFixed(2)}s`
  }

  /** ≥1s 视为需要立即关注（慢日志默认阈值 10ms，能进来的已经偏慢） */
  function durationTone(micros: number): 'warn' | null {
    return micros >= 1_000_000 ? 'warn' : null
  }

  function formatTime(ts: number): string {
    const d = new Date(ts * 1000)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  /**
   * 相对时间：「3 分钟前」比「2026-10-29 21:03:11」更好扫。
   * 慢查询的核心问题是"最近有没有慢"，相对时间直接回答这个问题；
   * 精确时间戳保留在单元格的 title 里，需要核对时悬停即可。
   */
  function timeAgo(ts: number): string {
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts)
    if (diff < 60) return '刚刚'
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
    if (diff < 86_400) return `${Math.floor(diff / 3600)} 小时前`
    return `${Math.floor(diff / 86_400)} 天前`
  }

  return (
    <section className="slow-card s-slowlog-card">
      <header className="slow-head">
        <h3 className="slow-title">
          <DialogIcon name="clock" size={14} className="slow-icon" />
          <span>慢查询日志</span>
        </h3>
        <span className="slow-count mono">{entries.length ? `最近 ${entries.length} 条` : ''}</span>
        <span className="spacer" />
        <button
          className="slow-reset"
          disabled={!connected || resetting || !entries.length}
          title="清空服务端慢查询日志（SLOWLOG RESET）"
          onClick={() => void resetSlowlog()}
        >
          <DialogIcon name="clear" size={12} className="ti" />
          清空
        </button>
      </header>

      {/*
        常驻解释「为什么是空的」。
        慢查询为空有两种原因：确实是最近没有慢命令，或者服务端阈值设得很高
        根本没记录 —— 不写清楚，用户会以为功能坏了。
      */}
      <p className="slow-hint">
        记录耗时超过 slowlog-log-slower-than（默认 10ms）的命令，服务端最多保留 slowlog-max-len 条
      </p>

      {error ? (
        <p className="slow-error">{error}</p>
      ) : loading && !overview ? (
        <p className="slow-empty">正在读取慢查询日志…</p>
      ) : entries.length ? (
        <table className="slow-table">
          <thead>
            <tr>
              <th className="col-id">ID</th>
              <th className="col-time">发生时间</th>
              <th className="col-cost">耗时</th>
              <th className="col-cmd">命令</th>
              <th className="col-client">客户端</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => (
              <tr key={entry.id}>
                {/*
                  序号而非服务端 ID：ID 是 Redis 内部的递增整数，
                  对"第几条"没有信息量；序号与阅读顺序一致。
                  ID 保留在 title 里，需要跟服务端核对时能看到。
                */}
                <td className="mono col-id" title={`服务端 ID ${entry.id}`}>
                  {i + 1}
                </td>
                <td className="col-time" title={formatTime(entry.timestamp)}>
                  {timeAgo(entry.timestamp)}
                </td>
                <td className={`mono col-cost ${durationTone(entry.duration) ?? ''}`.trim()}>
                  {formatDuration(entry.duration)}
                </td>
                <td className="mono col-cmd" title={entry.command.join(' ')}>
                  {entry.command.join(' ')}
                </td>
                {/*
                  优先连接名：多实例并存时 "redis-desktop" / "生产只读"
                  比 "172.16.30.11:52344" 更回答"是我哪个程序干的"。
                  没有名字时回退到地址。
                */}
                <td className="mono col-client" title={entry.client}>
                  {entry.clientName || entry.client || '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="slow-empty">
          {connected ? '最近没有超过阈值的命令；可在 redis.conf 中调低 slowlog-log-slower-than 观察' : '未连接'}
        </p>
      )}

      {overview ? (
        <p className="slow-summary mono">
          服务端共记录 {overview.len} 条
        </p>
      ) : null}
    </section>
  )
}

export default SlowlogCard
