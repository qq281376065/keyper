import { useRef, useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { SortIcon } from '@/components/SortIcon'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import type { MsgKey } from '@shared/i18n'
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
    title: MsgKey
    warn: MsgKey
    pending: MsgKey
    done: MsgKey
    running: MsgKey
    exec: MsgKey
    footHint: MsgKey
  }
> = {
  delete: {
    title: 'bulkOpsPanel.bulkDeleteKeys',
    warn: 'bulkOpsPanel.keysAllTheirDataDeleted',
    pending: 'bulkOpsPanel.pendingDelete',
    done: 'common.deleted',
    running: 'bulkOpsPanel.deleting',
    exec: 'bulkOpsPanel.delete',
    footHint: 'bulkOpsPanel.clickDeleteOnceEverythingLooks',
  },
  ttl: {
    title: 'bulkOpsPanel.bulkSetTtl',
    warn: 'bulkOpsPanel.expirationKeysRewrittenExisting',
    pending: 'bulkOpsPanel.notSet',
    done: 'bulkOpsPanel.set',
    running: 'bulkOpsPanel.applying',
    exec: 'bulkOpsPanel.applyTtl',
    footHint: 'bulkOpsPanel.clickApplyTtlOnceEverything',
  },
  rename: {
    title: 'bulkOpsPanel.bulkRename',
    warn: 'bulkOpsPanel.keyNamesRewrittenPrefixRule',
    pending: 'bulkOpsPanel.pendingRename',
    done: 'common.renamed',
    running: 'bulkOpsPanel.renaming',
    exec: 'bulkOpsPanel.rename',
    footHint: 'bulkOpsPanel.clickRenameOncePreviewLooks',
  },
}

/** TTL 快捷档：高频秒数 + 永久（-1 = PERSIST） */
const TTL_PRESETS: Array<{ label: MsgKey; value: number }> = [
  { label: 'common.oneMinute', value: 60 },
  { label: 'common.tenMinutes', value: 600 },
  { label: 'common.oneHour', value: 3600 },
  { label: 'common.oneDay', value: 86400 },
  { label: 'common.noExpiration', value: -1 },
]

type SortKey = 'type' | 'key' | 'ttl' | 'state'

export function BulkOpsPanel() {
  const { t } = useI18n()
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
    ? t('bulkOpsPanel.valueUnchangedAfterReplacement')
    : !renameChangeCount
      ? t('bulkOpsPanel.noKeysMatchPrefix')
      : t('bulkOpsPanel.renameChangedTotalKeysRest', {
          changed: renameChangeCount,
          total: task.items.length,
        })

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
    notify(done ? 'ok' : 'err', done ? t('common.copiedKeyName') : t('common.copyFailedCheckClipboardPermissions'))
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
  const ttlTargetText = task.ttlSeconds < 0 ? t('common.noExpiration') : t('bulkOpsPanel.seconds', { seconds: task.ttlSeconds })

  return (
    <div className="bulk s-bulk-ops-panel">
      <header className="bulk-head">
        <div className="bulk-title-row">
          <h2 className="bulk-title">{t(labels.title)}</h2>
          <span className="bulk-count mono">{t('bulkOpsPanel.count', { count: total })}</span>
          <span className="spacer" />
          {!started ? (
            <button className="btn tiny" onClick={closeBulkTask}>
              <DialogIcon name="cancel" size={13} />
              {t('common.cancel')}
            </button>
          ) : null}
        </div>

        <p className="bulk-warn">{t(labels.warn)}</p>

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
        {!started && task.action === 'ttl' ? (
          <div className="param-box">
            <span className="param-label">{t('bulkOpsPanel.ttlSecondsLabel')}</span>
            <input
              value={ttlText}
              onChange={(event) => syncTtl(event.target.value)}
              className="param-input mono"
              inputMode="numeric"
            />
            <span className="param-presets">
              {TTL_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  className={`chip${task.ttlSeconds === preset.value ? ' on' : ''}`}
                  onClick={() => syncTtl(String(preset.value))}
                >
                  {t(preset.label)}
                </button>
              ))}
            </span>
            <span className={`param-hint${ttlValid ? '' : ' warn'}`}>
              {ttlValid ? t('bulkOpsPanel.target', { target: ttlTargetText }) : t('bulkOpsPanel.ttlInvalid')}
            </span>
          </div>
        ) : null}

        {/* 重命名参数：原前缀 → 新前缀（只在未开始时出现） */}
        {!started && task.action === 'rename' ? (
          <div className="param-box">
            <span className="param-label">{t('bulkOpsPanel.replacePrefix')}</span>
            <input
              value={fromText}
              onChange={(event) => syncRename(event.target.value, toText)}
              className="param-input mono"
              placeholder={t('bulkOpsPanel.originalPrefix')}
            />
            <span className="param-arrow">→</span>
            <input
              value={toText}
              onChange={(event) => syncRename(fromText, event.target.value)}
              className="param-input mono"
              placeholder={t('bulkOpsPanel.newPrefix')}
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
            placeholder={t('bulkOpsPanel.searchKeyNamesList')}
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
            {t('common.type')}
            <SortIcon direction={sortKey === 'type' ? (sortAsc ? 'asc' : 'desc') : null} />
          </button>
          <button className={`col-key th-sort${sortKey === 'key' ? ' on' : ''}`} onClick={() => toggleSort('key')}>
            {t('common.keyName')}
            <SortIcon direction={sortKey === 'key' ? (sortAsc ? 'asc' : 'desc') : null} />
          </button>
          <button className={`col-ttl th-sort${sortKey === 'ttl' ? ' on' : ''}`} onClick={() => toggleSort('ttl')}>
            TTL
            <SortIcon direction={sortKey === 'ttl' ? (sortAsc ? 'asc' : 'desc') : null} />
          </button>
          <button className={`col-state th-sort${sortKey === 'state' ? ' on' : ''}`} onClick={() => toggleSort('state')}>
            {t('common.status')}
            <SortIcon direction={sortKey === 'state' ? (sortAsc ? 'asc' : 'desc') : null} />
          </button>
          <span className="col-ops">{t('common.operation')}</span>
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
                  <span className="state-ok">{t(labels.done)}</span>
                ) : isFailed(item.key) ? (
                  <span className="state-fail" {...tipProps(failReason(item.key) ?? '')}>
                    {t('bulkOpsPanel.failed')}
                  </span>
                ) : (
                  t(labels.pending)
                )}
              </span>
              <span className="col-ops">
                <button
                  className="row-act"
                  {...tipProps(t('common.copyKeyName'))}
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
                    {...tipProps(t('bulkOpsPanel.removeList'))}
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

          {!visible.length ? <p className="bulk-empty">{t('bulkOpsPanel.noMatchingKeyNames')}</p> : null}
        </div>
      </div>

      {/* 底部操作 */}
      <footer className="bulk-foot">
        {!started && task.action === 'ttl' ? (
          <p className="foot-hint">
            {t('bulkOpsPanel.target', { target: ttlTargetText })}
            {t(labels.footHint)}
          </p>
        ) : !started ? (
          <p className="foot-hint">{t(labels.footHint)}</p>
        ) : finished ? (
          <p className="foot-hint">
            {failedCount
              ? t('bulkOpsPanel.processedKeysWithFailures', {
                  count: doneCount,
                  ok: okCount,
                  failed: failedCount,
                })
              : t('bulkOpsPanel.processedKeysOk', { count: doneCount, ok: okCount })}
          </p>
        ) : (
          <p className="foot-hint">{t('bulkOpsPanel.processingNotClosePanel')}</p>
        )}

        <span className="spacer" />

        {!started ? (
          <>
            <button className="btn" onClick={closeBulkTask}>
              <DialogIcon name="cancel" size={13} />
              {t('common.cancel')}
            </button>
            <button className={execClass} disabled={!canRun} onClick={() => void runBulkTask()}>
              <DialogIcon name={execIcon} size={13} />
              {t(labels.exec)}
            </button>
          </>
        ) : task.running ? (
          <button className="btn" onClick={cancelBulkTask}>
            <DialogIcon name="stop" size={13} />
            {t('bulkOpsPanel.abort')}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={closeBulkTask}>
            <DialogIcon name="check" size={13} />
            {t('bulkOpsPanel.done')}
          </button>
        )}
      </footer>
    </div>
  )
}

export default BulkOpsPanel
