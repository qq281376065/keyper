import { useState } from 'react'
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
import { formatBytes, formatTtl, ttlTone } from '@/utils/format'
import type { BulkAction } from '@/store/session'
import type { MemcachedKeyItem } from '@shared/types'

/**
 * Memcached 批量操作面板（占用值区）。
 *
 * 与 Redis 的 BulkOpsPanel 同一套骨架：清单可搜索、可排序、逐行执行、
 * 支持中止。差异只在执行分支与列结构 —— Memcached 没有类型，
 * 多出「大小」列，TTL 由绝对到期时间换算。
 */

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

/** TTL 快捷档：高频秒数 + 永久（-1 = touch 的 exptime 0） */
const TTL_PRESETS: Array<{ label: MsgKey; value: number }> = [
  { label: 'common.oneMinute', value: 60 },
  { label: 'common.tenMinutes', value: 600 },
  { label: 'common.oneHour', value: 3600 },
  { label: 'common.oneDay', value: 86400 },
  { label: 'common.noExpiration', value: -1 },
]

type SortKey = 'key' | 'ttl' | 'size' | 'state'

/** 绝对到期时间 → Redis 语义 TTL（-1 永久），与键栏的 ttlOf 同规则 */
function ttlOf(item: MemcachedKeyItem): number {
  if (!item.expiresAt) return -1
  return Math.max(0, item.expiresAt - Math.floor(Date.now() / 1000))
}

export function MemcachedBulkOpsPanel() {
  const { t } = useI18n()
  const { state, runMcBulkTask, cancelMcBulkTask, closeMcBulkTask, notify } = useRedis()
  useObservable(useSessionStore())

  const task = state.mcBulkTask

  const [ttlText, setTtlText] = useState('3600')
  const [fromText, setFromText] = useState('')
  const [toText, setToText] = useState('')
  const [filter, setFilter] = useState('')
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortAsc, setSortAsc] = useState(true)

  if (!task) return null

  const labels = LABELS[task.action]

  /* -------------------------------------------------- 参数区 */

  const ttlValid = (() => {
    const raw = ttlText.trim()
    if (!raw) return false
    const n = Number(raw)
    if (!Number.isFinite(n)) return false
    return n === -1 || (Number.isInteger(n) && n > 0)
  })()

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

  const renameChangeCount =
    task.action === 'rename'
      ? task.items.filter((item) => renamedKey(item.key, fromText, toText) !== item.key).length
      : 0
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
  const execClass = task.action === 'delete' ? 'btn btn-danger' : 'btn btn-primary'
  const execIcon = task.action === 'ttl' ? 'clock' : task.action === 'rename' ? 'edit' : 'trash'

  /* -------------------------------------------------- 清单 */

  function toggleSort(key: SortKey): void {
    if (sortKey === key) {
      setSortAsc((prev) => !prev)
      return
    }
    setSortKey(key)
    setSortAsc(true)
  }

  const isDone = (key: string): boolean => task.succeeded.includes(key)
  const isFailed = (key: string): boolean => task.failed.some((item) => item.key === key)
  const failReason = (key: string): string | undefined => task.failed.find((item) => item.key === key)?.reason

  function stateOf(key: string): number {
    if (isDone(key)) return 0
    if (isFailed(key)) return 1
    return 2
  }

  const originIndexMap = new Map<string, number>()
  task.items.forEach((item, i) => originIndexMap.set(item.key, i + 1))

  const keyword = filter.trim().toLowerCase()
  const rows = keyword ? task.items.filter((item) => item.key.toLowerCase().includes(keyword)) : [...task.items]

  const visible = (() => {
    if (!sortKey) return rows
    const dir = sortAsc ? 1 : -1
    return rows.sort((a, b) => {
      switch (sortKey) {
        case 'key':
          return dir * a.key.localeCompare(b.key)
        case 'ttl': {
          const aForever = ttlOf(a) < 0
          const bForever = ttlOf(b) < 0
          if (aForever && bForever) return 0
          if (aForever) return 1
          if (bForever) return -1
          return dir * (ttlOf(a) - ttlOf(b))
        }
        case 'size':
          return dir * (a.bytes - b.bytes)
        case 'state':
          return dir * (stateOf(a.key) - stateOf(b.key))
      }
    })
  })()

  const total = task.items.length
  const okCount = task.succeeded.length
  const failedCount = task.failed.length
  const doneCount = task.done
  const started = doneCount > 0 || !!task.running
  const finished = started && !task.running
  const totalBytes = task.items.reduce((sum, item) => sum + item.bytes, 0)

  function removeItem(key: string): void {
    if (task!.running) return
    task!.items = task!.items.filter((item) => item.key !== key)
  }

  async function copyKey(key: string): Promise<void> {
    const done = await copyText(key)
    notify(done ? 'ok' : 'err', done ? t('common.copiedKeyName') : t('common.copyFailedCheckClipboardPermissions'))
  }

  const canOperate = (key: string): boolean => !isDone(key) && !isFailed(key)
  const keyDisplay = (key: string): string =>
    task.action === 'rename' ? `${key} → ${renamedKey(key, task.renameFrom, task.renameTo)}` : key
  const ttlTargetText =
    task.ttlSeconds < 0 ? t('common.noExpiration') : t('bulkOpsPanel.seconds', { seconds: task.ttlSeconds })

  return (
    <div className="bulk s-bulk-ops-panel s-mc-bulk-panel">
      <header className="bulk-head">
        <div className="bulk-title-row">
          <h2 className="bulk-title">{t(labels.title)}</h2>
          <span className="bulk-count mono">{t('bulkOpsPanel.count', { count: total })}</span>
          <span className="spacer" />
          {!started ? (
            <button className="btn tiny" onClick={closeMcBulkTask}>
              <DialogIcon name="cancel" size={13} />
              {t('common.cancel')}
            </button>
          ) : null}
        </div>

        <p className="bulk-warn">{t(labels.warn)}</p>

        {/* 摘要：条目数与总占用，替代 Redis 版的类型分布 */}
        <div className="type-stats">
          <span className="type-chip">
            <span className="type-badge type-string">M</span>
            <span className="mono">{total}</span>
          </span>
          <span className="type-chip">
            <span className="param-label">{t('common.size')}</span>
            <span className="mono">{formatBytes(totalBytes)}</span>
          </span>
        </div>

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

      <div className="bulk-table">
        <div className="bulk-table-head">
          <span className="col-idx">#</span>
          <button className={`col-key th-sort${sortKey === 'key' ? ' on' : ''}`} onClick={() => toggleSort('key')}>
            {t('common.keyName')}
            <SortIcon direction={sortKey === 'key' ? (sortAsc ? 'asc' : 'desc') : null} />
          </button>
          <button className={`col-ttl th-sort${sortKey === 'ttl' ? ' on' : ''}`} onClick={() => toggleSort('ttl')}>
            TTL
            <SortIcon direction={sortKey === 'ttl' ? (sortAsc ? 'asc' : 'desc') : null} />
          </button>
          <button className={`col-size th-sort${sortKey === 'size' ? ' on' : ''}`} onClick={() => toggleSort('size')}>
            {t('common.size')}
            <SortIcon direction={sortKey === 'size' ? (sortAsc ? 'asc' : 'desc') : null} />
          </button>
          <button className={`col-state th-sort${sortKey === 'state' ? ' on' : ''}`} onClick={() => toggleSort('state')}>
            {t('common.status')}
            <SortIcon direction={sortKey === 'state' ? (sortAsc ? 'asc' : 'desc') : null} />
          </button>
          <span className="col-ops">{t('common.operation')}</span>
        </div>

        <div className="bulk-list">
          {visible.map((item) => {
            const ttl = ttlOf(item)
            return (
              <div
                key={item.key}
                className={`bulk-row${isDone(item.key) ? ' done' : ''}${isFailed(item.key) ? ' failed' : ''}`}
              >
                <span className="col-idx mono">{originIndexMap.get(item.key) ?? 0}</span>
                <span className="col-key mono ellipsis" {...tipProps(keyDisplay(item.key))}>
                  {keyDisplay(item.key)}
                </span>
                <span className={`col-ttl ${ttlTone(ttl)}`.trim()}>
                  {task.action === 'ttl' ? (
                    <>
                      {formatTtl(ttl)} → {formatTtl(task.ttlSeconds)}
                    </>
                  ) : (
                    formatTtl(ttl)
                  )}
                </span>
                <span className="col-size mono">{formatBytes(item.bytes)}</span>
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
            )
          })}

          {!visible.length ? <p className="bulk-empty">{t('bulkOpsPanel.noMatchingKeyNames')}</p> : null}
        </div>
      </div>

      <footer className="bulk-foot">
        {!started && task.action === 'ttl' ? (
          <p className="foot-hint">
            {t('bulkOpsPanel.target', { target: ttlTargetText })} {t(labels.footHint)}
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
            <button className="btn" onClick={closeMcBulkTask}>
              <DialogIcon name="cancel" size={13} />
              {t('common.cancel')}
            </button>
            <button className={execClass} disabled={!canRun} onClick={() => void runMcBulkTask()}>
              <DialogIcon name={execIcon} size={13} />
              {t(labels.exec)}
            </button>
          </>
        ) : task.running ? (
          <button className="btn" onClick={cancelMcBulkTask}>
            <DialogIcon name="stop" size={13} />
            {t('bulkOpsPanel.abort')}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={closeMcBulkTask}>
            <DialogIcon name="check" size={13} />
            {t('bulkOpsPanel.done')}
          </button>
        )}
      </footer>
    </div>
  )
}

export default MemcachedBulkOpsPanel
