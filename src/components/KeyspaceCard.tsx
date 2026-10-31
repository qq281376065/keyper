import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import type { MsgKey } from '@shared/i18n'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { useSessionStore } from '@/hooks/useSessionStore'
import type { KeyspaceEvent } from '@shared/types'

/** 事件流保留上限：键空间通知是高频流，无上限会把渲染层拖死 */
const MAX_EVENTS = 200

/**
 * 订阅模式只订 keyevent 频道：
 * keyspace 与 keyevent 的载荷互为镜像（前者频道带键名、后者频道带事件名），
 * 两者都订会让一次操作推两条重复事件。
 */
const KEYSPACE_PATTERN = '__keyevent@*__:*'

/** 配置字符的展示顺序；A 是 g$lshzxetd 的别名，所以排在类型位之前 */
const FLAG_ORDER = ['K', 'E', 'A', 'g', '$', 'l', 's', 'h', 'z', 'x', 'e', 't', 'd', 'm', 'n'] as const
const CHANNEL_FLAGS = ['K', 'E'] as const
const TYPE_FLAGS = ['g', '$', 'l', 's', 'h', 'z', 'x', 'e', 't', 'd', 'm', 'n'] as const
/** A 覆盖的类型（Redis 文档：A 是 g$lshzxetd 的别名，不含 m / n） */
const A_TYPES = 'g$lshzxetd'

/** 每个配置字符的悬停说明：单字母过于抽象，图例在窄窗口下也容易被忽略 */
const FLAG_TIPS: Record<string, MsgKey> = {
  K: 'keyspaceCard.flagKeyspaceChannel',
  E: 'keyspaceCard.flagKeyeventChannel',
  A: 'keyspaceCard.flagAllTypes',
  g: 'keyspaceCard.flagGeneric',
  $: 'keyspaceCard.flagString',
  l: 'keyspaceCard.flagList',
  s: 'keyspaceCard.flagSet',
  h: 'keyspaceCard.flagHash',
  z: 'keyspaceCard.flagZset',
  x: 'keyspaceCard.flagExpired',
  e: 'keyspaceCard.flagEvicted',
  t: 'keyspaceCard.flagStream',
  d: 'keyspaceCard.flagModule',
  m: 'keyspaceCard.flagKeyMiss',
  n: 'keyspaceCard.flagNewKey',
}

function parseFlags(events: string): Set<string> {
  const known = new Set<string>(FLAG_ORDER)
  return new Set(events.split('').filter((ch) => known.has(ch)))
}

function buildEvents(flags: Set<string>): string {
  return FLAG_ORDER.filter((ch) => flags.has(ch)).join('')
}

/** 类型开关的选中态：A 打开时，它覆盖的类型一并显示为选中 */
function typeOn(flags: Set<string>, flag: string): boolean {
  return flags.has('A') ? A_TYPES.includes(flag) : flags.has(flag)
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 键空间通知面板：配置开关 + 独立订阅 + 实时事件流。
 *
 * 订阅使用主进程单独维护的连接（订阅模式下连接不能执行普通命令），
 * 与 Pub/Sub 面板的连接彼此独立 —— 各自停止 / 退订互不牵连。
 * 事件流只显示当前连接：多连接并存时按 connectionId 过滤。
 */
export function KeyspaceCard() {
  const { t } = useI18n()
  const { state, activeConnection, notify } = useRedis()
  useObservable(useSessionStore())

  const connected = activeConnection?.status === 'connected'
  const activeId = state.activeId

  /* ---------------------------------------------------------------- 配置 */
  const [config, setConfig] = useState<string | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [loadingConfig, setLoadingConfig] = useState(false)
  const [flags, setFlags] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)

  async function loadConfig(): Promise<void> {
    if (!activeId || loadingConfig) return
    setLoadingConfig(true)
    setConfigError(null)
    try {
      const res = await api.redis.keyspaceConfig(activeId)
      if (!res.ok) throw new Error(res.error)
      setConfig(res.data.events)
      setFlags(parseFlags(res.data.events))
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : t('keyspaceCard.configLoadFailed'))
    } finally {
      setLoadingConfig(false)
    }
  }

  function toggleFlag(flag: string): void {
    setFlags((prev) => {
      const next = new Set(prev)
      if (flag === 'A') {
        if (next.has('A')) {
          /* 关掉 A 时展开成具体类型，保留用户刚看到的选中范围 */
          next.delete('A')
          for (const ch of A_TYPES) next.add(ch)
        } else {
          next.add('A')
          for (const ch of TYPE_FLAGS) next.delete(ch)
        }
        return next
      }
      /* 在 A 模式下手动改类型：先把 A 展开，再应用这次改动 */
      if (next.has('A')) {
        next.delete('A')
        for (const ch of A_TYPES) next.add(ch)
      }
      if (next.has(flag)) next.delete(flag)
      else next.add(flag)
      return next
    })
  }

  const eventsValue = buildEvents(flags)

  async function applyConfig(): Promise<void> {
    if (!activeId || applying) return
    setApplying(true)
    try {
      const res = await api.redis.setKeyspaceConfig(activeId, eventsValue)
      if (!res.ok) throw new Error(res.error)
      setConfig(eventsValue)
      setConfigError(null)
      notify('ok', t('keyspaceCard.configApplied'))
    } catch (err) {
      notify('err', err instanceof Error ? err.message : t('keyspaceCard.configFailed'))
    } finally {
      setApplying(false)
    }
  }

  /* ---------------------------------------------------------------- 监听 */
  const [listening, setListening] = useState(false)
  const [busy, setBusy] = useState(false)
  const [listenError, setListenError] = useState<string | null>(null)

  async function startListening(): Promise<void> {
    if (!activeId || busy) return
    setBusy(true)
    setListenError(null)
    try {
      const res = await api.redis.keyspaceSubscribe(activeId, [KEYSPACE_PATTERN])
      if (!res.ok) throw new Error(res.error)
      setListening(res.data.patterns.length > 0)
    } catch (err) {
      setListenError(err instanceof Error ? err.message : t('keyspaceCard.startFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function stopListening(): Promise<void> {
    if (!activeId || busy) return
    setBusy(true)
    try {
      const res = await api.redis.keyspaceStop(activeId)
      if (!res.ok) throw new Error(res.error)
      setListening(false)
    } catch (err) {
      setListenError(err instanceof Error ? err.message : t('keyspaceCard.stopFailed'))
    } finally {
      setBusy(false)
    }
  }

  /* ---------------------------------------------------------------- 事件流 */
  const [events, setEvents] = useState<KeyspaceEvent[]>([])
  const [filter, setFilter] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)

  /* 回调注册一次，但过滤条件要读到当前连接 id */
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  useEffect(() => {
    const off = api.redis.onKeyspaceEvent((event) => {
      if (event.connectionId !== activeIdRef.current) return
      setEvents((prev) => {
        const next = [...prev, event]
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
      })
    })
    return () => off?.()
  }, [])

  /* 新事件自动滚到底部：事件流是「追最新」的阅读模式 */
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events.length])

  /*
   * 切换连接 / 断开：先断旧连接的订阅（不断的话它会一直活着收事件），
   * 再清空面板。本面板不做跨连接的状态迁移。
   */
  const prevIdRef = useRef(activeId)
  useEffect(() => {
    const prevId = prevIdRef.current
    if (prevId && prevId !== activeId) void api.redis.keyspaceStop(prevId).catch(() => {})
    prevIdRef.current = activeId
    setEvents([])
    setFilter('')
    setListening(false)
    setListenError(null)
    setConfig(null)
    setConfigError(null)
    setFlags(new Set())
    if (activeId && connected) void loadConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, connected])

  /* 面板销毁（离开概览页）时断掉订阅连接，不留只收不推的幽灵连接 */
  useEffect(() => {
    return () => {
      const id = activeIdRef.current
      if (id) void api.redis.keyspaceStop(id).catch(() => {})
    }
  }, [])

  const query = filter.trim().toLowerCase()
  const visible = query
    ? events.filter((event) =>
        `${event.event} ${event.key} ${event.channel} @${event.db}`.toLowerCase().includes(query),
      )
    : events

  return (
    <section className="ks-card s-keyspace-card">
      <header className="ks-head">
        <h3 className="ks-title">
          <DialogIcon name="bell" size={14} className="ks-icon" />
          <span>{t('keyspaceCard.title')}</span>
        </h3>
        <span className={`ks-state${listening ? ' on' : ''}`}>
          <i className="ks-dot" />
          {listening ? t('keyspaceCard.listening', { count: events.length }) : t('keyspaceCard.stopped')}
        </span>
        <span className="spacer" />
        {listening ? (
          <button
            className="ks-btn"
            disabled={busy}
            {...tipProps(t('keyspaceCard.stopTip'))}
            onClick={() => void stopListening()}
          >
            <DialogIcon name="power" size={12} className="ti" />
            {t('keyspaceCard.stop')}
          </button>
        ) : (
          <button
            className="ks-btn accent"
            disabled={!connected || busy}
            {...tipProps(t('keyspaceCard.startTip'))}
            onClick={() => void startListening()}
          >
            <DialogIcon name="play" size={12} className="ti" />
            {busy ? t('keyspaceCard.starting') : t('keyspaceCard.start')}
          </button>
        )}
      </header>

      {listenError ? (
        <p className="ks-error">
          <DialogIcon name="warning" size={12} className="ti" />
          {listenError}
        </p>
      ) : null}

      {/* -------------------------------------------------------- 配置 */}
      <div className="ks-config">
        <div className="ks-config-head">
          <span className="ks-config-name mono">notify-keyspace-events</span>
          <span className="ks-config-value mono" {...tipProps(config ?? '')}>
            {loadingConfig ? t('common.loading') : config == null ? t('keyspaceCard.configUnavailable') : config || t('keyspaceCard.disabledValue')}
          </span>
          <button
            className="ks-mini"
            disabled={!connected || loadingConfig}
            {...tipProps(t('keyspaceCard.reloadConfig'))}
            onClick={() => void loadConfig()}
          >
            <DialogIcon name="refresh" size={11} className={`ti${loadingConfig ? ' spin' : ''}`} />
          </button>
        </div>

        {configError ? <p className="ks-config-error">{configError}</p> : null}

        <div className="ks-flags">
          <span className="ks-flag-label">{t('keyspaceCard.channels')}</span>
          <div className="ks-flag-group">
            {CHANNEL_FLAGS.map((flag) => (
              <button
                key={flag}
                className={`ks-flag mono${flags.has(flag) ? ' on' : ''}`}
                {...tipProps(t(FLAG_TIPS[flag]!))}
                onClick={() => toggleFlag(flag)}
              >
                {flag}
              </button>
            ))}
          </div>
        </div>

        <div className="ks-flags">
          <span className="ks-flag-label">{t('keyspaceCard.eventTypes')}</span>
          <div className="ks-flag-group">
            <button
              className={`ks-flag mono${flags.has('A') ? ' on' : ''}`}
              {...tipProps(t(FLAG_TIPS.A!))}
              onClick={() => toggleFlag('A')}
            >
              A
            </button>
            {TYPE_FLAGS.map((flag) => (
              <button
                key={flag}
                className={`ks-flag mono${typeOn(flags, flag) ? ' on' : ''}${flags.has('A') ? ' implied' : ''}`}
                {...tipProps(t(FLAG_TIPS[flag]!))}
                onClick={() => toggleFlag(flag)}
              >
                {flag}
              </button>
            ))}
          </div>
        </div>

        <p className="ks-legend">{t('keyspaceCard.flagsHint')}</p>

        <div className="ks-config-foot">
          <span className="ks-preview mono">
            {t('keyspaceCard.valuePreview', {
              value: eventsValue || t('keyspaceCard.disabledValue'),
            })}
          </span>
          {flags.has('E') ? null : <span className="ks-e-hint">{t('keyspaceCard.eChannelHint')}</span>}
          <span className="spacer" />
          <button
            className="ks-btn"
            disabled={!connected || applying || eventsValue === (config ?? '')}
            {...tipProps(t('keyspaceCard.applyConfigTip'))}
            onClick={() => void applyConfig()}
          >
            <DialogIcon name="check" size={12} className="ti" />
            {applying ? t('keyspaceCard.applying') : t('keyspaceCard.applyConfig')}
          </button>
        </div>
      </div>

      {/* -------------------------------------------------------- 事件流 */}
      <div className="ks-stream-head">
        <span>{t('keyspaceCard.eventStream', { count: visible.length })}</span>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="ks-filter"
          placeholder={t('keyspaceCard.filterPlaceholder')}
        />
        {events.length ? (
          <button
            className="ks-clear"
            {...tipProps(t('keyspaceCard.clearEventsTip'))}
            onClick={() => setEvents([])}
          >
            <DialogIcon name="clear" size={11} className="ti" />
            {t('common.clear')}
          </button>
        ) : null}
      </div>

      <div ref={listRef} className="ks-stream">
        {visible.map((event, index) => (
          <div key={`${event.timestamp}-${index}`} className="ks-event">
            <span className="mono ks-time">{formatTime(event.timestamp)}</span>
            <span className="mono ks-db">{t('keyspaceCard.dbLabel', { db: event.db })}</span>
            <span className="mono ks-event-name" {...tipProps(event.channel)}>
              {event.event}
            </span>
            <span className="mono ks-key" {...tipProps(event.key)}>
              {event.key}
            </span>
          </div>
        ))}
        {!visible.length ? (
          <div className="ks-empty">
            {events.length ? t('keyspaceCard.noMatch') : t('keyspaceCard.empty')}
          </div>
        ) : null}
      </div>

      <p className="ks-hint">{t('keyspaceCard.listenHint')}</p>
    </section>
  )
}

export default KeyspaceCard
