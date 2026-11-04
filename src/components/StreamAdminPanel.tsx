import { useCallback, useEffect, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { PromptDialog } from '@/components/PromptDialog'
import { useI18n } from '@/i18n'
import { useRedis } from '@/store/useRedis'
import type {
  StreamConsumer,
  StreamGroup,
  StreamPendingEntry,
  StreamPendingSummary,
} from '@shared/types'

function formatIdle(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60}m`
}

export function StreamAdminPanel({
  keyName,
  tab,
  initialGroup,
  onOpenPending,
  pendingIdle = true,
}: {
  keyName: string
  tab: 'groups' | 'pending'
  initialGroup?: string
  onOpenPending: (group: string) => void
  pendingIdle?: boolean
}) {
  const { t } = useI18n()
  const { state, notify, askConfirm } = useRedis()
  const [groups, setGroups] = useState<StreamGroup[]>([])
  const [group, setGroup] = useState(initialGroup ?? '')
  const [consumers, setConsumers] = useState<StreamConsumer[]>([])
  const [summary, setSummary] = useState<StreamPendingSummary | null>(null)
  const [pending, setPending] = useState<StreamPendingEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [settingId, setSettingId] = useState(false)
  const [claiming, setClaiming] = useState(false)

  const connectionId = state.activeId

  const loadGroups = useCallback(async () => {
    if (!connectionId) return
    setLoading(true)
    try {
      const res = await api.redis.streamGroups(connectionId, keyName)
      if (!res.ok) throw new Error(res.error)
      setGroups(res.data)
      setGroup((current) => current || res.data[0]?.name || '')
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [connectionId, keyName, notify])

  const loadPending = useCallback(
    async (target: string, nextCursor?: string) => {
      if (!connectionId || !target) return
      setLoading(true)
      try {
        const [summaryRes, consumersRes, pendingRes] = await Promise.all([
          api.redis.streamPendingSummary(connectionId, keyName, target),
          api.redis.streamConsumers(connectionId, keyName, target),
          api.redis.streamPending(connectionId, keyName, target, {
            cursor: nextCursor,
            count: 50,
          }),
        ])
        if (!summaryRes.ok) throw new Error(summaryRes.error)
        if (!consumersRes.ok) throw new Error(consumersRes.error)
        if (!pendingRes.ok) throw new Error(pendingRes.error)
        setSummary(summaryRes.data)
        setConsumers(consumersRes.data)
        setPending((current) =>
          nextCursor ? [...current, ...pendingRes.data.entries] : pendingRes.data.entries,
        )
        setCursor(pendingRes.data.nextCursor)
      } catch (error) {
        notify('err', error instanceof Error ? error.message : String(error))
      } finally {
        setLoading(false)
      }
    },
    [connectionId, keyName, notify],
  )

  useEffect(() => {
    void loadGroups()
  }, [loadGroups])

  useEffect(() => {
    if (tab !== 'pending') return
    if (!group) return
    setPending([])
    setCursor(null)
    void loadPending(group)
  }, [tab, group, loadPending])

  async function createGroup(name: string): Promise<void> {
    if (!connectionId || !name.trim()) return
    const res = await api.redis.streamGroupCreate(connectionId, keyName, name.trim(), '$', true)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    notify('ok', t('streamGroups.created'))
    setCreating(false)
    void loadGroups()
  }

  async function destroyGroup(target: StreamGroup): Promise<void> {
    if (!connectionId) return
    const confirmed = await askConfirm({
      title: t('streamGroups.destroyTitle'),
      message: t('streamGroups.destroyMessage', { group: target.name, count: target.pending }),
      confirmText: t('common.delete'),
      danger: true,
    })
    if (!confirmed) return
    const res = await api.redis.streamGroupDestroy(connectionId, keyName, target.name)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    notify('ok', t('streamGroups.destroyed'))
    void loadGroups()
  }

  async function setGroupId(id: string): Promise<void> {
    if (!connectionId || !group || !id.trim()) return
    const res = await api.redis.streamGroupSetId(connectionId, keyName, group, id.trim())
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    notify('ok', t('streamGroups.setIdDone'))
    setSettingId(false)
    void loadPending(group)
  }

  async function ack(entry: StreamPendingEntry): Promise<void> {
    if (!connectionId || !group) return
    const res = await api.redis.streamAck(connectionId, keyName, group, [entry.id])
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    notify('ok', t('streamPending.acked', { count: res.data.affected }))
    setPending((current) => current.filter((item) => item.id !== entry.id))
    void loadPending(group)
  }

  async function claim(consumer: string): Promise<void> {
    if (!connectionId || !group || !consumer.trim()) return
    const res = await api.redis.streamClaim(connectionId, keyName, group, consumer.trim(), 0, [
      ...pending.map((entry) => entry.id),
    ])
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    notify('ok', t('streamPending.claimed', { count: res.data.affected }))
    setClaiming(false)
    void loadPending(group)
  }

  if (tab === 'groups') {
    return (
      <div className="stream-admin">
        <header className="sa-head">
          <span className="sa-title">{t('streamGroups.title')}</span>
          <span className="spacer" />
          <button className="btn tiny" onClick={() => setCreating(true)}>
            <DialogIcon name="add" size={11} />
            {t('streamGroups.create')}
          </button>
        </header>
        {loading && !groups.length ? (
          <p className="sa-empty">{t('common.loading')}</p>
        ) : !groups.length ? (
          <p className="sa-empty">{t('streamGroups.noGroups')}</p>
        ) : (
          <table className="sa-table">
            <thead>
              <tr>
                <th>{t('streamGroups.groupName')}</th>
                <th>{t('streamGroups.consumers')}</th>
                <th>{t('streamGroups.pending')}</th>
                <th>{t('streamGroups.lag')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.map((item) => (
                <tr key={item.name}>
                  <td className="mono ellipsis" title={item.name}>
                    {item.name}
                  </td>
                  <td className="mono">{item.consumers}</td>
                  <td className="mono">{item.pending}</td>
                  <td className="mono">{item.lag ?? '—'}</td>
                  <td className="sa-actions">
                    <button className="btn tiny" onClick={() => onOpenPending(item.name)}>
                      <DialogIcon name="eye" size={11} />
                      {t('streamGroups.viewPending')}
                    </button>
                    <button className="btn tiny" onClick={() => { setGroup(item.name); setSettingId(true) }}>
                      <DialogIcon name="edit" size={11} />
                      {t('streamGroups.setId')}
                    </button>
                    <button className="btn tiny btn-danger" onClick={() => void destroyGroup(item)}>
                      <DialogIcon name="trash" size={11} />
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {creating ? (
          <PromptDialog
            title={t('streamGroups.create')}
            label={t('streamGroups.groupName')}
            initialValue=""
            placeholder=""
            hint={t('streamGroups.startHint')}
            confirmText={t('common.create')}
            onConfirm={(name) => void createGroup(name)}
            onCancel={() => setCreating(false)}
          />
        ) : null}
        {settingId ? (
          <PromptDialog
            title={t('streamGroups.setIdTitle')}
            label={t('streamGroups.setIdValue')}
            initialValue="$"
            placeholder="0 / $ / 1700000000000-0"
            hint={t('streamGroups.startHint')}
            confirmText={t('common.save')}
            onConfirm={(id) => void setGroupId(id)}
            onCancel={() => setSettingId(false)}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div className="stream-admin">
      <header className="sa-head">
        <span className="sa-title">{t('streamPending.title')}</span>
        <select
          className="sa-select mono"
          value={group}
          onChange={(event) => setGroup(event.target.value)}
        >
          <option value="">{t('streamPending.group')}</option>
          {groups.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
        <span className="sa-summary mono">
          {summary
            ? t('streamPending.summary', {
                count: summary.count,
                min: summary.minId ?? '—',
                max: summary.maxId ?? '—',
              })
            : ''}
        </span>
        <span className="spacer" />
        <button
          className="btn tiny"
          disabled={!pending.length}
          onClick={() => setClaiming(true)}
        >
          <DialogIcon name="link" size={11} />
          {t('streamPending.claim')}
        </button>
      </header>

      {!group ? (
        <p className="sa-empty">{t('streamPending.noGroup')}</p>
      ) : loading && !pending.length ? (
        <p className="sa-empty">{t('common.loading')}</p>
      ) : !pending.length ? (
        <p className="sa-empty">{t('streamPending.empty')}</p>
      ) : (
        <>
          {consumers.length ? (
            <div className="sa-consumers">
              {consumers.map((consumer) => (
                <span className="sa-consumer" key={consumer.name}>
                  <span className="mono ellipsis">{consumer.name}</span>
                  <b className="mono">{consumer.pending}</b>
                  {pendingIdle ? (
                    <span className="mono sa-consumer-idle">{formatIdle(consumer.idleMs)}</span>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
          <table className="sa-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>{t('streamPending.consumer')}</th>
                {pendingIdle ? <th>{t('streamPending.idle')}</th> : null}
                <th>{t('streamPending.deliveries')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono ellipsis" title={entry.id}>
                    {entry.id}
                  </td>
                  <td className="mono ellipsis">{entry.consumer}</td>
                  {pendingIdle ? <td className="mono">{formatIdle(entry.idleMs)}</td> : null}
                  <td className="mono">{entry.deliveries}</td>
                  <td className="sa-actions">
                    <button className="btn tiny" onClick={() => void ack(entry)}>
                      <DialogIcon name="check" size={11} />
                      {t('streamPending.ack')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <footer className="sa-foot">
            <span className="mono">
              {consumers.length} {t('streamGroups.consumers')}
            </span>
            <span className="spacer" />
            {cursor ? (
              <button className="btn tiny" disabled={loading} onClick={() => void loadPending(group, cursor)}>
                {t('streamPending.loadMore')}
              </button>
            ) : null}
          </footer>
        </>
      )}

      {claiming ? (
        <PromptDialog
          title={t('streamPending.claimTitle')}
          label={t('streamPending.claimConsumer')}
          initialValue={consumers[0]?.name ?? ''}
          placeholder=""
          hint={t('streamPending.claimHint', { count: pending.length })}
          confirmText={t('streamPending.claim')}
          onConfirm={(consumer) => void claim(consumer)}
          onCancel={() => setClaiming(false)}
        />
      ) : null}
    </div>
  )
}
