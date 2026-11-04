import { useEffect, useMemo, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { FilterBox } from '@/components/FilterBox'
import { LiveTtl } from '@/components/LiveTtl'
import { tipProps } from '@/components/tip'
import { useSessionStore } from '@/hooks/useSessionStore'
import { useI18n } from '@/i18n'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { typeAbbr, typeLabel } from '@/utils/typeLabel'
import type { FavoriteEntry, RedisKeyItem } from '@shared/types'

/** undefined = 元信息尚未取到；null = 键已不存在 */
interface FavoriteMetaInfo {
  /** Redis 的类型；Memcached 没有类型 */
  type: RedisKeyItem['type'] | null
  /** 剩余秒数；null 表示服务端不提供 TTL */
  ttl: number | null
  ttlAt?: number
}
type FavoriteMeta = FavoriteMetaInfo | null | undefined

const META_CONCURRENCY = 8

function entryId(entry: Pick<FavoriteEntry, 'db' | 'key'>): string {
  return `${entry.db}\u0000${entry.key}`
}

/**
 * 收藏视图。
 *
 * 收藏只存键名与库号，类型 / TTL 在打开视图时批量补取（并发 8）；
 * 取不到即标记失效，不静默删除 —— 用户可能只是暂时切到了别的实例。
 */
export function FavoritesPanel() {
  const { state, activeConnection, openFavorite, removeFavorite, clearFavorites, askConfirm } = useRedis()
  useObservable(useSessionStore())
  const { t } = useI18n()
  const engine = activeConnection?.engine ?? 'redis'
  const [meta, setMeta] = useState<Record<string, FavoriteMeta>>({})
  const [metaLoading, setMetaLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const [query, setQuery] = useState('')

  const connId = state.activeId
  const entries = state.favorites

  useEffect(() => {
    if (!connId) {
      setMeta({})
      setMetaLoading(false)
      return
    }
    let cancelled = false
    const next: Record<string, FavoriteMeta> = {}
    setMeta({})
    setMetaLoading(entries.length > 0)
    void (async () => {
      for (let i = 0; i < entries.length; i += META_CONCURRENCY) {
        const batch = entries.slice(i, i + META_CONCURRENCY)
        const items = await Promise.all(
          batch.map(async (entry) => {
            if (engine === 'memcached') {
              const res = await api.memcached.get(connId, entry.key)
              if (!res.ok) return undefined
              if (!res.data.found) return null
              return {
                type: null,
                ttl: res.data.ttl ?? null,
                ttlAt: res.data.ttl != null ? Date.now() : undefined,
              } satisfies FavoriteMetaInfo
            }
            const res = await api.redis.lookupKey(connId, entry.key, entry.db)
            if (!res.ok) return undefined
            return res.data
              ? { type: res.data.type, ttl: res.data.ttl, ttlAt: Date.now() }
              : null
          }),
        )
        if (cancelled) return
        batch.forEach((entry, index) => {
          next[entryId(entry)] = items[index]
        })
        setMeta({ ...next })
      }
      if (!cancelled) setMetaLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [connId, entries, tick, engine])

  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const visible = keyword ? entries.filter((entry) => entry.key.toLowerCase().includes(keyword)) : entries
    const map = new Map<number, FavoriteEntry[]>()
    for (const entry of visible) {
      const bucket = map.get(entry.db) ?? []
      bucket.push(entry)
      map.set(entry.db, bucket)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [entries, query])

  const filteredCount = groups.reduce((total, [, list]) => total + list.length, 0)
  const dbCount = useMemo(() => new Set(entries.map((entry) => entry.db)).size, [entries])
  const staleCount = useMemo(
    () => Object.values(meta).filter((item) => item === null).length,
    [meta],
  )

  async function clearAll(): Promise<void> {
    const confirmed = await askConfirm({
      title: t('favorites.clearTitle'),
      message: t('favorites.clearMessage', { count: entries.length }),
      confirmText: t('favorites.clearConfirm'),
      danger: true,
    })
    if (confirmed) await clearFavorites()
  }

  return (
    <section className="fav-panel">
      <header className="fav-head">
        <FilterBox
          value={query}
          onChange={setQuery}
          placeholder={t('favorites.searchPlaceholder')}
          className="fav-search"
        />
        <button className="btn-ghost icon" {...tipProps(t('favorites.refresh'))} onClick={() => setTick((value) => value + 1)}>
          <DialogIcon name="refresh" size={12} />
        </button>
        <button
          className="btn-ghost icon fav-clear"
          disabled={!entries.length}
          {...tipProps(t('favorites.clear'))}
          onClick={() => void clearAll()}
        >
          <DialogIcon name="clear" size={12} />
        </button>
      </header>

      <div className="fav-body">
        {!entries.length ? (
          <p className="fav-empty">{t('favorites.empty')}</p>
        ) : !groups.length ? (
          <p className="fav-empty">{t('favorites.noMatches', { query: query.trim() })}</p>
        ) : (
          groups.map(([db, list]) => (
            <div className="fav-group" key={db}>
              {engine === 'memcached' ? null : (
                <div className="fav-db mono">{t('favorites.dbGroup', { db })}</div>
              )}
              {list.map((entry) => {
                const info = meta[entryId(entry)]
                const stale = info === null
                return (
                  <div className={`fav-row${stale ? ' stale' : ''}`} key={entryId(entry)}>
                    <span className="fav-star on" aria-hidden="true">
                      <DialogIcon name="star" size={12} />
                    </span>
                    <button
                      className="fav-key mono ellipsis"
                      {...tipProps(entry.key)}
                      onClick={() => void openFavorite(entry)}
                    >
                      {entry.key}
                    </button>
                    {info?.type ? (
                      <span className={`type-badge type-${info.type}`} {...tipProps(typeLabel(info.type))}>
                        {typeAbbr(info.type)}
                      </span>
                    ) : null}
                    {info ? (
                      info.ttl == null ? (
                        <span className="fav-ttl mono">—</span>
                      ) : (
                        <LiveTtl className="fav-ttl mono" ttl={info.ttl} ttlAt={info.ttlAt} />
                      )
                    ) : stale ? (
                      <span className="fav-stale">{t('favorites.stale')}</span>
                    ) : (
                      <span className="fav-ttl mono">—</span>
                    )}
                    <button
                      className="fav-del"
                      {...tipProps(t('favorites.remove'))}
                      onClick={() => void removeFavorite(entry)}
                    >
                      <DialogIcon name="trash" size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>

      <footer className="fav-status">
        <span className="mono">{t('favorites.statsTotal', { count: entries.length })}</span>
        {engine === 'redis' ? (
          <>
            <span className="sep">·</span>
            <span className="mono">{t('favorites.statsDbs', { count: dbCount })}</span>
          </>
        ) : null}
        {query.trim() ? (
          <>
            <span className="sep">·</span>
            <span className="mono">
              {t('favorites.statsFiltered', { shown: filteredCount, total: entries.length })}
            </span>
          </>
        ) : null}
        {staleCount ? (
          <>
            <span className="sep">·</span>
            <span className="mono fav-status-stale">
              {t('favorites.statsStale', { count: staleCount })}
            </span>
          </>
        ) : null}
        <span className="spacer" />
        {metaLoading ? <span className="mono">{t('favorites.statsLoading')}</span> : null}
      </footer>
    </section>
  )
}
