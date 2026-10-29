import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { globalHolder } from '@/store/global'
import { copyText } from '@/utils/clipboard'
import { isMutation, logSeverity } from '@/utils/log'
import type { LogEntry, LogFileInfo } from '@shared/types'

export interface LogPanelProps {
  /** 正在播放离场动画：此时外部会等动画结束再卸载 */
  closing?: boolean
  onClose: () => void
  /** 离场动画播放完毕，通知父组件可以卸载了 */
  onClosed: () => void
}

/**
 * 操作日志抽屉（右侧滑入）。
 *
 * 关闭入口只有左侧收起手柄 —— 遮罩点击与 Esc 都已按需求移除。
 * 这样面板不会因为划选文本、误触空白或误按 Esc 而意外消失。
 */
export function LogPanel({ closing, onClose, onClosed }: LogPanelProps) {
  const { state, notify } = useRedis()
  useObservable(globalHolder)

  const [dates, setDates] = useState<LogFileInfo[]>([])
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [activeDate, setActiveDate] = useState('')
  const [connectionFilter, setConnectionFilter] = useState('')
  const [keyword, setKeyword] = useState('')
  /** 仅看变更：过滤掉命令执行、连接等常规操作，直击删除与改数据 */
  const [changesOnly, setChangesOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [logPath, setLogPath] = useState('')

  const drawerRef = useRef<HTMLElement | null>(null)

  /**
   * 监听抽屉本体的动画结束事件。
   *
   * 只认 .log-drawer 自己的动画（离场时的那一个），
   * 并检查 event.target 排除子元素冒泡上来的动画事件 ——
   * 抽屉内部还有其它元素可能带动画，不加以区分会提前触发卸载。
   */
  /**
   * 离场动画结束 → 通知父组件卸载。
   *
   * 抽屉与把手是两个并列元素，各自跑动画；两者时长相同（0.26s），
   * 但浏览器不保证回调顺序。这里以**抽屉**的结束事件为准（它是主体），
   * 把手的动画只负责视觉同步，不参与卸载判定 —— 若两个都触发 onClosed，
   * 会卸载两次（第二次时组件已不在，父层状态机可能重复转移）。
   */
  function handleDrawerAnimationEnd(event: React.AnimationEvent): void {
    if (!closing) return
    if (event.target !== drawerRef.current) return
    onClosed()
  }

  /** 面板中实际展示的条目 */
  const visibleEntries = changesOnly
    ? entries.filter((entry) => isMutation(entry.action, entry.detail))
    : entries

  /** 变更类操作数量，用于工具栏提示 */
  const mutationCount = entries.filter((entry) => isMutation(entry.action, entry.detail)).length

  const connectionOptions = (() => {
    const names = state.connections.map((item) => item.name)
    for (const entry of entries) {
      if (!names.includes(entry.connectionName)) names.push(entry.connectionName)
    }
    return names
  })()

  function formatDay(date: string): string {
    if (date.length !== 8) return date
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
  }

  function formatTime(timestamp: number): string {
    const date = new Date(timestamp)
    const pad = (value: number, size = 2) => String(value).padStart(size, '0')
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  }

  async function loadDates(currentDate?: string): Promise<string> {
    const [datesRes, dirRes] = await Promise.all([api.log.dates(), api.log.dir()])
    let next = currentDate ?? ''
    if (datesRes.ok) {
      setDates(datesRes.data)
      if (!next) next = datesRes.data[0]?.date ?? ''
      setActiveDate(next)
    }
    if (dirRes.ok) setLogPath(dirRes.data)
    return next
  }

  async function loadEntries(options?: {
    date?: string
    connection?: string
    keywordText?: string
  }): Promise<void> {
    setLoading(true)
    try {
      const res = await api.log.read({
        date: options?.date ?? (activeDate || undefined),
        connection: options?.connection ?? (connectionFilter || undefined),
        keyword: options?.keywordText ?? (keyword.trim() || undefined),
      })
      if (res.ok) {
        setEntries(res.data)
      } else {
        setEntries([])
        notify('err', res.error)
      }
    } finally {
      setLoading(false)
    }
  }

  async function refresh(): Promise<void> {
    const date = await loadDates(activeDate)
    await loadEntries({ date })
  }

  async function handleDateChange(value: string): Promise<void> {
    setActiveDate(value)
    await loadEntries({ date: value })
  }

  /**
   * 复制某一行的详情。
   * 详情列在界面上被 ellipsis 截断，长键名 / 长命令看不全，
   * 复制按钮是把它完整取出来的唯一入口。
   */
  async function copyDetail(detail: string): Promise<void> {
    if (!detail) {
      notify('err', '该行没有详情可复制')
      return
    }
    const done = await copyText(detail)
    notify(done ? 'ok' : 'err', done ? '已复制详情' : '复制失败，请检查剪贴板权限')
  }

  async function openDir(): Promise<void> {
    const res = await api.log.openDir()
    if (res.ok) notify('ok', res.data.message ?? '已打开日志目录')
    else notify('err', res.error)
  }

  useEffect(() => {
    void (async () => {
      const date = await loadDates()
      await loadEntries({ date })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    /*
      单一根容器：抽屉与收起手柄都放进这个 wrapper。
      wrapper 本身是包围全屏的定位容器，不拦截点击
      （pointer-events: none），由内部的抽屉各自响应。
      closing 为真时整层切到离场动画（向右滑出 + 淡出）。
    */
    <div className={`log-layer${closing ? ' closing' : ''} s-log-panel`}>
      {/*
        遮罩已移除：需求是「只有收起手柄能关闭」，铺满全屏的半透明层
        只会拦截主界面点击并误导用户。
      */}
      {/*
        收起手柄：只留图标，不放文字。
        抽屉边缘是一条窄竖条，竖排文字会把它撑宽、挤压抽屉本体；
        而 `→` 本身就表达了"往右收起"的方向。
      */}
      <button className="drawer-handle" {...tipProps('收起面板')} onClick={onClose}>
        <DialogIcon name="arrow-right" size={14} className="handle-chevron" />
      </button>

      <aside
        ref={drawerRef}
        className="log-drawer"
        role="dialog"
        aria-label="操作日志"
        onAnimationEnd={handleDrawerAnimationEnd}
      >
        <div className="drawer-head">
          <span className="title">操作日志</span>
          <span className="sub">仅记录手动操作</span>
          <span className="spacer" />
        </div>

        <div className="toolbar">
          <select
            className="date-select mono"
            value={activeDate}
            onChange={(event) => void handleDateChange(event.target.value)}
          >
            {!dates.length ? <option value="">暂无日志</option> : null}
            {dates.map((item) => (
              <option key={item.date} value={item.date}>
                {formatDay(item.date)} · {formatSize(item.size)}
              </option>
            ))}
          </select>

          <select
            value={connectionFilter}
            className="conn-select"
            onChange={(event) => {
              setConnectionFilter(event.target.value)
              void loadEntries({ connection: event.target.value })
            }}
          >
            <option value="">全部连接</option>
            {connectionOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          {/* 搜索框：图标嵌在输入框内部左侧，避免额外占一行或挤占工具栏 */}
          <div className="keyword-wrap">
            <svg className="keyword-icon" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7.2" cy="7.2" r="4.4" />
              <path d="M10.5 10.5 14 14" />
            </svg>
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              className="keyword"
              placeholder="按操作 / 详情 / 结果过滤"
              onKeyUp={(event) => {
                if (event.key === 'Enter') void loadEntries()
              }}
            />
          </div>

          <button
            className={`btn-ghost toggle${changesOnly ? ' on' : ''}`}
            {...tipProps(changesOnly ? '当前仅显示变更操作，点击查看全部' : '只看删除与改数据的操作')}
            onClick={() => setChangesOnly((prev) => !prev)}
          >
            <DialogIcon name="activity" size={12} />
            仅看变更
            {mutationCount ? <span className="badge mono">{mutationCount}</span> : null}
          </button>

          <button className="btn-ghost icon" {...tipProps('刷新')} onClick={() => void refresh()}>
            <DialogIcon name="refresh" size={13} />
          </button>
          <button className="btn-ghost icon" {...tipProps('打开日志目录')} onClick={() => void openDir()}>
            <DialogIcon name="folder-open" size={13} />
          </button>
        </div>

        {/*
          表格外壳：统一控制左右留白。
          表头与数据区都放在这一层里，留白只在外壳上声明一次。
        */}
        <div className="log-table">
          <div className="log-head">
            <span className="col-time">时间</span>
            <span className="col-conn">连接</span>
            <span className="col-action">操作</span>
            <span className="col-detail">详情</span>
            <span className="col-result">结果</span>
            <span className="col-ops">操作</span>
          </div>

          <div className="log-body">
            {visibleEntries.map((entry, index) => {
              const severity = logSeverity(entry.action, entry.detail)
              return (
                <div key={index} className={`log-row ${severity}${entry.ok ? '' : ' fail'}`}>
                  <span className="col-time mono">{formatTime(entry.timestamp)}</span>
                  <span className="col-conn ellipsis" {...tipProps(entry.connectionName)}>
                    {entry.connectionName}
                  </span>
                  <span className="col-action">
                    <span className={`sev-dot ${severity}`} />
                    {entry.action}
                  </span>
                  <span className="col-detail mono ellipsis" {...tipProps(entry.detail)}>
                    {entry.detail}
                  </span>
                  <span className="col-result ellipsis" {...tipProps(entry.result)}>
                    <span className={`status ${entry.ok ? 'ok' : 'fail'}`}>{entry.ok ? 'OK' : 'FAIL'}</span>
                    <span className="result-text">{entry.result}</span>
                    {entry.costMs != null ? <span className="cost mono">{entry.costMs}ms</span> : null}
                  </span>
                  <span className="col-ops">
                    <button
                      className="row-copy"
                      {...tipProps('复制详情')}
                      onClick={(event) => {
                        event.stopPropagation()
                        void copyDetail(entry.detail)
                      }}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <rect x="5.4" y="5.4" width="8.2" height="8.2" rx="1.2" />
                        <path d="M10.6 5.4V3.6a1.2 1.2 0 0 0-1.2-1.2H3.6a1.2 1.2 0 0 0-1.2 1.2v5.8a1.2 1.2 0 0 0 1.2 1.2h1.8" />
                      </svg>
                    </button>
                  </span>
                </div>
              )
            })}

            {/*
              加载态沿用项目的统一写法：转圈 + 文字，
              与值区刷新、键扫描保持同一视觉语言。
            */}
            {loading ? (
              <div className="loading-state">
                <span className="spinner" />
                <span className="loading-text">正在加载日志…</span>
              </div>
            ) : !visibleEntries.length ? (
              <p className="placeholder">
                {changesOnly ? '当天没有变更类操作' : '该日期暂无日志记录'}
                <br />
                <span className="hint">
                  {changesOnly ? '关闭「仅看变更」可查看全部记录' : '执行命令或修改键之后，日志会出现在这里'}
                </span>
              </p>
            ) : null}
          </div>
        </div>

        <footer className="drawer-foot">
          <span className="mono ellipsis" {...tipProps(logPath)}>
            {logPath || '—'}
          </span>
          <span className="spacer" />
          <span className="legend">
            <span className="sev-dot danger" />
            删除
            <span className="sev-dot change" />
            变更
          </span>
          <span className="mono">{changesOnly ? `${visibleEntries.length} / ${entries.length}` : entries.length} 条</span>
        </footer>
      </aside>
    </div>
  )
}

export default LogPanel
