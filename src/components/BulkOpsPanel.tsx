import { useRef, useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { SortIcon } from '@/components/SortIcon'
import { tipProps } from '@/components/tip'
import { renamedKey } from '@/store/session'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { useSessionStore } from '@/hooks/useSessionStore'
import { copyText } from '@/utils/clipboard'
import { formatTtl, ttlTone } from '@/utils/format'
import type { BulkAction } from '@/store/session'

/**
 * 批量操作面板（占用值区）：删除 / 统一设置 TTL / 前缀替换重命名。
 *
 * 为什么不做成弹窗：
 * 待处理清单可能有上千条，弹窗里只能展示前 30 行并标注「已截断」，
 * 用户既核对不了内容，也无从判断自己选的是不是想要的那一批。
 * 值区有足够的纵向空间，可以完整滚动浏览、搜索筛选、边执行边看进度。
 *
 * 操作逻辑与原弹窗保持一致：仍然需要用户主动确认；
 * 删除不可撤销 —— 变化的只是承载形式。
 */

/** 按 action 区分的文案与按钮：三种操作共用一套骨架，差异全在这里收口 */
const LABELS: Record<
  BulkAction,
  {
    title: string
    warn: string
    pending: string
    done: string
    running: string
    exec: string
    footHint: string
  }
> = {
  delete: {
    title: '批量删除键',
    warn: '以下键及其全部数据将被删除，此操作不可撤销。请确认清单无误后再执行。',
    pending: '待删除',
    done: '已删除',
    running: '删除中…',
    exec: '执行删除',
    footHint: '确认无误后点击「执行删除」。删除将逐个进行，期间可以中止。',
  },
  ttl: {
    title: '批量设置 TTL',
    warn: '以下键的过期时间将被统一改写，原有的剩余时间会被覆盖。请确认清单与秒数无误。',
    pending: '待设置',
    done: '已设置',
    running: '设置中…',
    exec: '应用 TTL',
    footHint: '确认无误后点击「应用 TTL」。设置将逐个进行，期间可以中止。',
  },
  rename: {
    title: '批量重命名',
    warn: '以下键名将按前缀规则替换。目标键名已存在时该键会被跳过并标记失败，不会覆盖。',
    pending: '待重命名',
    done: '已重命名',
    running: '重命名中…',
    exec: '执行重命名',
    footHint: '确认预览无误后点击「执行重命名」。重命名将逐个进行，期间可以中止。',
  },
}

/** TTL 快捷档：高频秒数 + 永久（-1 = PERSIST） */
const TTL_PRESETS = [
  { label: '1 分钟', value: 60 },
  { label: '10 分钟', value: 600 },
  { label: '1 小时', value: 3600 },
  { label: '1 天', value: 86400 },
  { label: '永久', value: -1 },
]

type SortKey = 'type' | 'key' | 'ttl' | 'state'

export function BulkOpsPanel() {
  const { state, runBulkTask, cancelBulkTask, closeBulkTask, notify } = useRedis()
  useObservable(useSessionStore())

  const task = state.bulkTask

  /**
   * 输入框绑定文本而非数字：用户键入的中间态（"36"、"360"、删空的 ""）
   * 都不是合法秒数，数字 state 会在这些瞬间丢字符；文本 + 校验最稳。
   */
  const [ttlText, setTtlText] = useState('3600')
  const [fromText, setFromText] = useState('')
  const [toText, setToText] = useState('')
  const [filter, setFilter] = useState('')
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortAsc, setSortAsc] = useState(true)

  if (!task) return null

  const labels = LABELS[task.action]

  /* -------------------------------------------------- 参数区 */

  /** 合法秒数：正整数或 -1（永久）。其余（空 / 小数 / 0 / 负数）不允许执行 */
  const ttlValid = (() => {
    const raw = ttlText.trim()
    if (!raw) return false
    const n = Number(raw)
    if (!Number.isFinite(n)) return false
    return n === -1 || (Number.isInteger(n) && n > 0)
  })()

  /** 校验通过才把值写回任务，非法值不覆盖上一次的合法值 */
  function syncTtl(raw: string): void {
    setTtlText(raw)
    const n = Number(raw.trim())
    if (Number.isFinite(n) && (n === -1 || (Number.isInteger(n) && n > 0))) {
      task!.ttlSeconds = n
    }
  }

  function syncRename(from: string, to: string): void {
    setFromText(from)
    setToText(to)
    task!.renameFrom = from
    task!.renameTo = to
  }

  /** 替换规则下真正会发生变化的键数（前缀未命中的键执行时直接跳过） */
  const renameChangeCount =
    task.action === 'rename'
      ? task.items.filter((item) => renamedKey(item.key, fromText, toText) !== item.key).length
      : 0

  /** 规则是否有效：from === to（含都为空）时替换等于没替换 */
  const renameValid = fromText !== toText

  const renameHint = !renameValid
    ? '替换前后一致，请调整前缀'
    : !renameChangeCount
      ? '没有键命中该前缀'
      : `将重命名 ${renameChangeCount} / ${task.items.length} 个键，其余保持不变`

  const canRun =
    task.action === 'ttl' ? ttlValid : task.action === 'rename' ? renameValid && renameChangeCount > 0 : true

  /** 执行按钮配色：删除是破坏性操作用强调色，TTL / 重命名用主按钮 */
  const execClass = task.action === 'delete' ? 'btn btn-danger' : 'btn btn-primary'
  /** 执行按钮图标：clock = TTL、edit = 重命名、trash = 删除 */
  const execIcon = task.action === 'ttl' ? 'clock' : task.action === 'rename' ? 'edit' : 'trash'

  /* -------------------------------------------------- 清单 */

  /** 点击列标题切换排序：同一列再点反转，换列从升序开始 */
  function toggleSort(key: SortKey): void {
    if (sortKey === key) {
      setSortAsc((prev) => !prev)
      return
    }
    setSortKey(key)
    setSortAsc(true)
  }

  /** 是否已成功处理，用于区分"已成功"与"被过滤掉" */
  const isDone = (key: string): boolean => task.succeeded.includes(key)
  const isFailed = (key: string): boolean => task.failed.some((item) => item.key === key)
  const failReason = (key: string): string | undefined => task.failed.find((item) => item.key === key)?.reason

  /** 行状态：已成功 / 失败 / 待处理，供「状态」列排序用 */
  function stateOf(key: string): number {
    if (isDone(key)) return 0
    if (isFailed(key)) return 1
    return 2
  }

  /**
   * 序号 = 该键在**原始清单**里的位置，而不是当前显示的第几行。
   * 排序只是换了个观察角度，清单本身没变；若序号跟随排序结果重排，
   * 同一行在切换排序时会从 7 变成 23，用户会以为清单内容变了。
   */
  const originIndexMap = new Map<string, number>()
  task.items.forEach((item, i) => originIndexMap.set(item.key, i + 1))

  const keyword = filter.trim().toLowerCase()
  const rows = keyword ? task.items.filter((item) => item.key.toLowerCase().includes(keyword)) : [...task.items]

  const visible = (() => {
    if (!sortKey) return rows
    /*
     * TTL 排序把「永久」(-1) 放在最后：
     * 数值上 -1 最小，直接比较会让所有持久键霸占升序榜首，
     * 而用户想看的通常是"快过期的排前面"。方向反转时同样保持永久在末尾。
     */
    const dir = sortAsc ? 1 : -1
    return rows.sort((a, b) => {
      switch (sortKey) {
        case 'type':
          return dir * a.type.localeCompare(b.type)
        case 'key':
          return dir * a.key.localeCompare(b.key)
        case 'ttl': {
          /*
           * 永久键（ttl = -1）始终排在末尾，不参与方向反转。
           * 不能简单地把它换成 Infinity —— 降序时 dir = -1，
           * Infinity * -1 会变成 -Infinity，永久键反而跑到最前面。
           */
          const aForever = a.ttl < 0
          const bForever = b.ttl < 0
          if (aForever && bForever) return 0
          if (aForever) return 1
          if (bForever) return -1
          return dir * (a.ttl - b.ttl)
        }
        case 'state':
          return dir * (stateOf(a.key) - stateOf(b.key))
      }
    })
  })()

  const total = task.items.length
  const okCount = task.succeeded.length
  const failedCount = task.failed.length
  const doneCount = task.done
  const progress = total ? Math.round((doneCount / total) * 100) : 0

  /** 已完成 = 正在跑 或 已跑完（有结果） */
  const started = doneCount > 0 || !!task.running
  const finished = started && !task.running

  /** 类型分布：让用户先知道这批里都是些什么东西，再决定怎么处理 */
  const typeStats = (() => {
    const stats = new Map<string, number>()
    for (const item of task.items) stats.set(item.type, (stats.get(item.type) ?? 0) + 1)
    return [...stats.entries()].sort((a, b) => b[1] - a[1])
  })()

  /** 从清单中移除单行（执行前使用） */
  function removeItem(key: string): void {
    if (task!.running) return
    task!.items = task!.items.filter((item) => item.key !== key)
  }

  /** 复制键名：清单里的键名可能很长，被 ellipsis 截断后看不全 */
  async function copyKey(key: string): Promise<void> {
    const done = await copyText(key)
    notify(done ? 'ok' : 'err', done ? '已复制键名' : '复制失败，请检查剪贴板权限')
  }

  /**
   * 某一行是否可执行操作。
   * 已成功、已失败的行不再提供操作 —— 对已处理的键再点"移除"没有意义，
   * 失败的键则需要保留在清单里供查看原因。
   */
  const canOperate = (key: string): boolean => !isDone(key) && !isFailed(key)

  /** 键名展示文本：重命名任务带「→ 新名」预览 */
  const keyDisplay = (key: string): string =>
    task.action === 'rename' ? `${key} → ${renamedKey(key, task.renameFrom, task.renameTo)}` : key

  /** 底栏的目标说明：「永久」比「-1 秒」更像人话 */
  const ttlTargetText = task.ttlSeconds < 0 ? '永久' : `${task.ttlSeconds} 秒`

  return (
    <div className="bulk s-bulk-ops-panel">
      <header className="bulk-head">
        <div className="bulk-title-row">
          <h2 className="bulk-title">{labels.title}</h2>
          <span className="bulk-count mono">{total} 个</span>
          <span className="spacer" />
          {!started ? (
            <button className="btn tiny" onClick={closeBulkTask}>
              <DialogIcon name="cancel" size={13} />
              取消
            </button>
          ) : null}
        </div>

        <p className="bulk-warn">{labels.warn}</p>

        {/* 类型分布：执行前先看清这批里都是什么 */}
        <div className="type-stats">
          {typeStats.map(([type, count]) => (
            <span key={type} className="type-chip">
              <span className={`type-badge type-${type}`}>{type}</span>
              <span className="mono">{count}</span>
            </span>
          ))}
        </div>

        {/* TTL 参数：统一秒数 + 快捷档（只在未开始时出现） */}
        {/* 重命名参数：原前缀 → 新前缀（只在未开始时出现） */}
        {!started && task.action === 'rename' ? (
          <div className="param-box">
            <span className="param-label">替换前缀</span>
            <input
              value={fromText}
              onChange={(event) => syncRename(event.target.value, toText)}
              className="param-input mono"
              placeholder="原前缀（留空 = 添加前缀）"
            />
            <span className="param-arrow">→</span>
            <input
              value={toText}
              onChange={(event) => syncRename(fromText, event.target.value)}
              className="param-input mono"
              placeholder="新前缀"
            />
            <span className={`param-hint${canRun ? '' : ' warn'}`}>{renameHint}</span>
          </div>
        ) : null}
      </header>

      {/* 执行中/已完成：进度条 */}
      {/* 过滤 */}
      <div className="bulk-filter">
        <div className="filter-wrap">
          <svg className="filter-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7.2" cy="7.2" r="4.4" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="filter-input"
            placeholder="在清单中搜索键名"
          />
        </div>
        <span className="mono filter-count">
          {visible.length} / {total}
        </span>
      </div>

      {/* 清单：表头 + 数据行共用同一套 grid 列宽，保证纵向对齐 */}
      <div className="bulk-table">
        <div className="bulk-table-head">
          <span className="col-idx">#</span>
          <button className={`col-type th-sort${sortKey === 'type' ? ' on' : ''}`} onClick={() => toggleSort('type')}>
            类型
            <SortIcon direction={sortKey === 'type' ? (sortAsc ? 'asc' : 'desc') : null} />
          </button>
          <button className={`col-key th-sort${sortKey === 'key' ? ' on' : ''}`} onClick={() => toggleSort('key')}>
            键名
            <SortIcon direction={sortKey === 'key' ? (sortAsc ? 'asc' : 'desc') : null} />
          </button>
          <button className={`col-ttl th-sort${sortKey === 'ttl' ? ' on' : ''}`} onClick={() => toggleSort('ttl')}>
            TTL
            <SortIcon direction={sortKey === 'ttl' ? (sortAsc ? 'asc' : 'desc') : null} />
          </button>
          <button className={`col-state th-sort${sortKey === 'state' ? ' on' : ''}`} onClick={() => toggleSort('state')}>
            状态
            <SortIcon direction={sortKey === 'state' ? (sortAsc ? 'asc' : 'desc') : null} />
          </button>
          <span className="col-ops">操作</span>
        </div>

        <div className="bulk-list">
          {visible.map((item) => (
            <div
              key={item.key}
              className={`bulk-row${isDone(item.key) ? ' done' : ''}${isFailed(item.key) ? ' failed' : ''}`}
            >
              <span className="col-idx mono">{originIndexMap.get(item.key) ?? 0}</span>
              <span className="col-type">
                <span className={`type-badge type-${item.type}`}>{item.type}</span>
              </span>
              <span className="col-key mono ellipsis" {...tipProps(keyDisplay(item.key))}>
                {keyDisplay(item.key)}
              </span>
              <span className={`col-ttl ${ttlTone(item.ttl)}`.trim()}>
                {task.action === 'ttl' ? (
                  <>
                    {formatTtl(item.ttl)} → {formatTtl(task.ttlSeconds)}
                  </>
                ) : (
                  formatTtl(item.ttl)
                )}
              </span>
              <span className="col-state">
                {isDone(item.key) ? (
                  <span className="state-ok">{labels.done}</span>
                ) : isFailed(item.key) ? (
                  <span className="state-fail" {...tipProps(failReason(item.key) ?? '')}>
                    失败
                  </span>
                ) : (
                  labels.pending
                )}
              </span>
              <span className="col-ops">
                <button
                  className="row-act"
                  {...tipProps('复制键名')}
                  onClick={(event) => {
                    event.stopPropagation()
                    void copyKey(item.key)
                  }}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="5.4" y="5.4" width="8.2" height="8.2" rx="1.2" />
                    <path d="M10.6 5.4V3.6a1.2 1.2 0 0 0-1.2-1.2H3.6a1.2 1.2 0 0 0-1.2 1.2v5.8a1.2 1.2 0 0 0 1.2 1.2h1.8" />
                  </svg>
                </button>
                {canOperate(item.key) && !started ? (
                  <button
                    className="row-act danger"
                    {...tipProps('从清单中移除')}
                    onClick={(event) => {
                      event.stopPropagation()
                      removeItem(item.key)
                    }}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                ) : null}
              </span>
            </div>
          ))}

          {!visible.length ? <p className="bulk-empty">没有匹配的键名</p> : null}
        </div>
      </div>

      {/* 底部操作 */}
      <footer className="bulk-foot">
        {!started && task.action === 'ttl' ? (
          <p className="foot-hint">
            目标 {ttlTargetText}。{labels.footHint}
          </p>
        ) : !started ? (
          <p className="foot-hint">{labels.footHint}</p>
        ) : finished ? (
          <p className="foot-hint">
            已处理 {doneCount} 个键：成功 {okCount}
            {failedCount ? `，失败 ${failedCount}` : ''}。
          </p>
        ) : (
          <p className="foot-hint">正在处理，请勿关闭面板…</p>
        )}

        <span className="spacer" />

        {!started ? (
          <>
            <button className="btn" onClick={closeBulkTask}>
              <DialogIcon name="cancel" size={13} />
              取消
            </button>
            <button className={execClass} disabled={!canRun} onClick={() => void runBulkTask()}>
              <DialogIcon name={execIcon} size={13} />
              {labels.exec}
            </button>
          </>
        ) : task.running ? (
          <button className="btn" onClick={cancelBulkTask}>
            <DialogIcon name="stop" size={13} />
            中止
          </button>
        ) : (
          <button className="btn btn-primary" onClick={closeBulkTask}>
            <DialogIcon name="check" size={13} />
            完成
          </button>
        )}
      </footer>
    </div>
  )
}

export default BulkOpsPanel
