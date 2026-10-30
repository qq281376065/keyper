import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { globalHolder } from '@/store/global'
import { copyText } from '@/utils/clipboard'
import { isMutation, logSeverity } from '@/utils/log'
import type { CacheEngine, LogEntry, LogFileInfo } from '@shared/types'
import { engineMeta } from '@/utils/engine'
import { useI18n } from '@/i18n'

export interface LogPanelProps {
  /** 正在播放离场动画：此时外部会等动画结束再卸载 */
  closing?: boolean
  onClose: () => void
  /** 离场动画播放完毕，通知父组件可以卸载了 */
  onClosed: () => void
}

type LogSortKey = 'connection' | 'time' | 'action' | 'detail' | 'result'

function sortValue(entry: LogEntry, key: LogSortKey): string | number {
  switch (key) {
    case 'connection':
      return entry.connectionName
    case 'time':
      return entry.timestamp
    case 'action':
      return entry.action
    case 'detail':
      return entry.detail
    case 'result':
      // 结果列以状态徽标为主：先按成功/失败分组，再比结果文本
      return `${entry.ok ? '0' : '1'} ${entry.result}`
  }
}

/**
 * 日志表头的排序图标：始终是上下双三角。
 *
 * 不用通用的 SortIcon —— 它在已排序时换成单个实心三角，
 * 与未排序列的双箭头形状不一致；单三角的可视重心也偏低，
 * 和中文标签并排时看起来没有垂直居中。
 * 这里固定双三角几何，只把当前方向的那一半点亮，形状始终统一。
 */
function LogSortIcon({ direction }: { direction: 'asc' | 'desc' | null }) {
  return (
    <svg viewBox="0 0 12 12" className="sort-tri s-sort-icon log-sort-tri" aria-hidden="true">
      <path className={direction === 'asc' ? 'lit' : undefined} d="M6 1.6 9.1 5.2H2.9z" />
      <path className={direction === 'desc' ? 'lit' : undefined} d="M6 10.4 2.9 6.8h6.2z" />
    </svg>
  )
}

/**
 * 操作日志抽屉（右侧滑入）。
 *
 * 关闭入口只有左侧收起手柄 —— 遮罩点击与 Esc 都已按需求移除。
 * 这样面板不会因为划选文本、误触空白或误按 Esc 而意外消失。
 */
export function LogPanel({ closing, onClose, onClosed }: LogPanelProps) {
  const { state, notify } = useRedis()
  const { t, locale } = useI18n()
  /** 连接名 / 操作名可能是中文，用当前界面语言的排序规则而不是码点序 */
  const logCollator = useMemo(
    () => new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }),
    [locale],
  )
  useObservable(globalHolder)

  const [dates, setDates] = useState<LogFileInfo[]>([])
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [activeDate, setActiveDate] = useState('')
  const [connectionFilter, setConnectionFilter] = useState('')
  /*
   * 引擎筛选。
   * 两种引擎的日志写在同一个文件里（同一天一个文件），
   * 不提供筛选的话，用户在排查 Redis 问题时会不断看到 Memcached 的行。
   */
  const [engineFilter, setEngineFilter] = useState<'' | CacheEngine>('')
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

  /** 排序列：默认时间倒序，与日志「新→旧」的阅读习惯一致 */
  const [sortKey, setSortKey] = useState<LogSortKey>('time')
  const [sortAsc, setSortAsc] = useState(false)

  /** 面板中实际展示的条目：先按「仅看变更」过滤，再按当前列排序 */
  const filteredEntries = changesOnly
    ? entries.filter((entry) => isMutation(entry.action, entry.detail))
    : entries
  const visibleEntries = [...filteredEntries].sort((a, b) => {
    const left = sortValue(a, sortKey)
    const right = sortValue(b, sortKey)
    const cmp =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : logCollator.compare(String(left), String(right))
    return sortAsc ? cmp : -cmp
  })

  /** 点击表头：同列切换升降序，换列时时间默认倒序、文本列默认升序 */
  function toggleSort(key: LogSortKey): void {
    if (sortKey === key) {
      setSortAsc((prev) => !prev)
      return
    }
    setSortKey(key)
    setSortAsc(key !== 'time')
  }

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
    engine?: '' | CacheEngine
  }): Promise<void> {
    setLoading(true)
    try {
      const res = await api.log.read({
        date: options?.date ?? (activeDate || undefined),
        connection: options?.connection ?? (connectionFilter || undefined),
        keyword: options?.keywordText ?? (keyword.trim() || undefined),
        engine: (options?.engine ?? engineFilter) || undefined,
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
      notify('err', t('该行没有详情可复制'))
      return
    }
    const done = await copyText(detail)
    notify(done ? 'ok' : 'err', done ? t('已复制详情') : t('复制失败，请检查剪贴板权限'))
  }

  async function openDir(): Promise<void> {
    const res = await api.log.openDir()
    if (res.ok) notify('ok', res.data.message ?? t('已打开日志目录'))
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
      <button className="drawer-handle" {...tipProps(t('收起面板'))} onClick={onClose}>
        <DialogIcon name="arrow-right" size={14} className="handle-chevron" />
      </button>

      <aside
        ref={drawerRef}
        className="log-drawer"
        role="dialog"
        aria-label={t('操作日志')}
        onAnimationEnd={handleDrawerAnimationEnd}
      >
        <div className="drawer-head">
          <span className="title">{t('操作日志')}</span>
          <span className="sub">{t('仅记录手动操作')}</span>
          <span className="spacer" />
        </div>

        <div className="toolbar">
          <select
            className="date-select mono"
            value={activeDate}
            onChange={(event) => void handleDateChange(event.target.value)}
          >
            {!dates.length ? <option value="">{t('暂无日志')}</option> : null}
            {dates.map((item) => (
              <option key={item.date} value={item.date}>
                {formatDay(item.date)} · {formatSize(item.size)}
              </option>
            ))}
          </select>

          <select
            value={engineFilter}
            className="conn-select"
            onChange={(event) => {
              const next = event.target.value as '' | CacheEngine
              setEngineFilter(next)
              void loadEntries({ engine: next })
            }}
          >
            <option value="">{t('全部模块')}</option>
            <option value="redis">Redis</option>
            <option value="memcached">Memcached</option>
          </select>

          <select
            value={connectionFilter}
            className="conn-select"
            onChange={(event) => {
              setConnectionFilter(event.target.value)
              void loadEntries({ connection: event.target.value })
            }}
          >
            <option value="">{t('全部连接')}</option>
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
              placeholder={t('按操作 / 详情 / 结果过滤')}
              onKeyUp={(event) => {
                if (event.key === 'Enter') void loadEntries()
              }}
            />
          </div>

          <button
            className={`btn-ghost toggle${changesOnly ? ' on' : ''}`}
            {...tipProps(
              changesOnly ? t('当前仅显示变更操作，点击查看全部') : t('只看删除与改数据的操作'),
            )}
            onClick={() => setChangesOnly((prev) => !prev)}
          >
            <DialogIcon name="activity" size={12} />
            {t('仅看变更')}
            {mutationCount ? <span className="badge mono">{mutationCount}</span> : null}
          </button>

          <button className="btn-ghost icon" {...tipProps(t('刷新'))} onClick={() => void refresh()}>
            <DialogIcon name="refresh" size={13} />
          </button>
          <button className="btn-ghost icon" {...tipProps(t('打开日志目录'))} onClick={() => void openDir()}>
            <DialogIcon name="folder-open" size={13} />
          </button>
        </div>

        {/*
          表格外壳：统一控制左右留白。
          表头放在滚动区内（sticky 吸顶）：两者共享同一个滚动视口，
          竖向滚动条出现时列宽同步收缩，「操作」列不会相对表头左右漂移。
        */}
        <div className="log-table">
          <div className="log-body">
            <div className="log-head">
              <button
                className={`col-conn log-sort${sortKey === 'connection' ? ' on' : ''}`}
                onClick={() => toggleSort('connection')}
              >
                {t('连接')}
                <LogSortIcon direction={sortKey === 'connection' ? (sortAsc ? 'asc' : 'desc') : null} />
              </button>
              <button
                className={`col-time log-sort${sortKey === 'time' ? ' on' : ''}`}
                onClick={() => toggleSort('time')}
              >
                {t('时间')}
                <LogSortIcon direction={sortKey === 'time' ? (sortAsc ? 'asc' : 'desc') : null} />
              </button>
              <button
                className={`col-action log-sort${sortKey === 'action' ? ' on' : ''}`}
                onClick={() => toggleSort('action')}
              >
                {t('操作')}
                <LogSortIcon direction={sortKey === 'action' ? (sortAsc ? 'asc' : 'desc') : null} />
              </button>
              <button
                className={`col-detail log-sort${sortKey === 'detail' ? ' on' : ''}`}
                onClick={() => toggleSort('detail')}
              >
                {t('详情')}
                <LogSortIcon direction={sortKey === 'detail' ? (sortAsc ? 'asc' : 'desc') : null} />
              </button>
              <button
                className={`col-result log-sort${sortKey === 'result' ? ' on' : ''}`}
                onClick={() => toggleSort('result')}
              >
                {t('结果')}
                <LogSortIcon direction={sortKey === 'result' ? (sortAsc ? 'asc' : 'desc') : null} />
              </button>
              <span className="col-ops">{t('操作')}</span>
            </div>

            {visibleEntries.map((entry, index) => {
              const severity = logSeverity(entry.action, entry.detail)
              return (
                <div key={index} className={`log-row ${severity}${entry.ok ? '' : ' fail'}`}>
                  {/*
                    连接列放最前：先回答「这条操作发生在哪个实例」。
                    引擎标记与名称同格：它是连接的属性，不该单独占一列 ——
                    独立成列会让表头与数据行错开一格。
                  */}
                  <span className="col-conn">
                    <span
                      className={`engine-chip engine-${entry.engine}`}
                      {...tipProps(engineMeta(entry.engine).label)}
                    >
                      {engineMeta(entry.engine).short}
                    </span>
                    <span className="conn-name ellipsis" {...tipProps(entry.connectionName)}>
                      {entry.connectionName}
                    </span>
                  </span>
                  <span className="col-time mono">{formatTime(entry.timestamp)}</span>
                  <span className="col-action">
                    <span className={`sev-dot ${severity}`} />
                    {t(entry.action)}
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
                      {...tipProps(t('复制详情'))}
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
                <span className="loading-text">{t('正在加载日志…')}</span>
              </div>
            ) : !visibleEntries.length ? (
              <p className="placeholder">
                {changesOnly ? t('当天没有变更类操作') : t('该日期暂无日志记录')}
                <br />
                <span className="hint">
                  {changesOnly
                    ? t('关闭「仅看变更」可查看全部记录')
                    : t('执行命令或修改键之后，日志会出现在这里')}
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
            {t('删除')}
            <span className="sev-dot change" />
            {t('变更')}
          </span>
          <span className="mono">
            {t('{count} 条', {
              count: changesOnly ? `${visibleEntries.length} / ${entries.length}` : entries.length,
            })}
          </span>
        </footer>
      </aside>
    </div>
  )
}

export default LogPanel
