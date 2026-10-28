import { useEffect, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useDialogDrag } from '@/hooks/useDialogDrag'
import { useRedis } from '@/store/useRedis'
import { copyText } from '@/utils/clipboard'
import { parseRedisVersion, resolveCapabilities } from '@/utils/redisCapability'
import type { VersionInfo } from '@shared/types'
import { globalHolder } from '@/store/global'
import { useObservable } from '@/store/subscription'

export interface VersionInfoDialogProps {
  connectionId: string
  connectionName: string
  host: string
  port: number
  onClose: () => void
}

/** 关键字段：判断兼容性与排障时最先要看的那几个 */
const ESSENTIAL_KEYS = new Set([
  'redis_version',
  'redis_mode',
  'os',
  'arch_bits',
  'tcp_port',
  'uptime_in_days',
  'connected_clients',
  'maxclients',
  'used_memory_human',
  'maxmemory_human',
  'maxmemory_policy',
  'role',
  'connected_slaves',
  'cluster_enabled',
  'aof_enabled',
  'rdb_last_bgsave_status',
])

export function VersionInfoDialog({
  connectionId,
  connectionName,
  host,
  port,
  onClose,
}: VersionInfoDialogProps) {
  const { notify } = useRedis()
  /* 订阅全局：toast / 连接列表变化时同步重渲染 */
  useObservable(globalHolder)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [info, setInfo] = useState<VersionInfo | null>(null)
  /** 只看关键项：默认收起次要字段，避免一屏堆几十行 */
  const [essentialOnly, setEssentialOnly] = useState(true)

  const { style, onDragStart } = useDialogDrag()

  async function load(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const res = await api.redis.versionInfo(connectionId)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setInfo(res.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  async function copyRaw(): Promise<void> {
    const raw = info?.raw
    if (!raw) return
    const done = await copyText(raw)
    notify(done ? 'ok' : 'err', done ? '已复制完整 INFO 输出' : '复制失败，请检查剪贴板权限')
  }

  const capabilities = resolveCapabilities(info?.version)
  const versionParts = parseRedisVersion(info?.version)

  /** 兼容性结论：直接影响界面上哪些功能可用 */
  const compatibility: Array<{ name: string; ok: boolean; note: string }> = []
  if (capabilities.versionKnown) {
    compatibility.push(
      {
        name: 'hash 字段级 TTL',
        ok: capabilities.hashFieldTtl,
        note: capabilities.hashFieldTtl ? 'HEXPIRE / HTTL 可用' : '需 Redis 7.4+，当前仅支持键级 TTL',
      },
      {
        name: 'set 成员级 TTL',
        ok: capabilities.setMemberTtl,
        note: capabilities.setMemberTtl ? 'SHEXPIRE / STTL 可用' : '需 Redis 7.4+',
      },
      {
        name: 'ACL（用户名认证）',
        ok: (versionParts?.major ?? 0) > 5,
        note: (versionParts?.major ?? 0) > 5 ? '支持 USER / PASSWORD' : '需 Redis 6.0+，仅支持密码',
      },
      {
        name: '多线程 IO',
        ok: (versionParts?.major ?? 0) > 5,
        note: (versionParts?.major ?? 0) > 5 ? 'io-threads 可配' : '需 Redis 6.0+',
      },
    )
  }

  const allGroups = info?.groups ?? []
  const groups = essentialOnly
    ? allGroups
        .map((group) => ({
          section: group.section,
          entries: group.entries.filter((entry) => ESSENTIAL_KEYS.has(entry.key) || entry.key.startsWith('db')),
        }))
        .filter((group) => group.entries.length > 0)
    : allGroups

  return (
    <div className="mask s-version-info-dialog">
      <div className="dialog" style={style}>
        <header className="dialog-head" onMouseDown={onDragStart}>
          <span>版本信息</span>
          <span className="conn-name ellipsis" {...tipProps(connectionName)}>
            {connectionName}
          </span>
          <span className="target mono">
            {host}:{port}
          </span>
          <span className="spacer" />
          <button className="btn-ghost tiny" disabled={loading} onClick={() => void load()}>
            <DialogIcon name="refresh" size={13} />
          </button>
          <button className="btn-ghost tiny" onClick={onClose}>
            <DialogIcon name="cancel" size={12} />
          </button>
        </header>

        <div className="dialog-body">
          {loading ? (
            <p className="placeholder">正在读取 INFO…</p>
          ) : error ? (
            <p className="placeholder err">{error}</p>
          ) : info ? (
            <>
              {/* 版本概览 */}
              <section className="hero">
                <div className="version-box">
                  <span className="version mono">{info.version || '未知'}</span>
                  <span className="mode">{info.mode}</span>
                </div>
                <div className="hero-note">
                  版本号决定界面可用能力，下方「能力探测」列出本实例的实际支持情况。
                </div>
              </section>

              {/* 能力探测：直接影响界面功能是否展示 */}
              {/* INFO 分组 */}
              {groups.map((group) => (
                <section key={group.section} className="block">
                  <h3>{group.section}</h3>
                  <div className="kv-table">
                    {group.entries.map((entry) => (
                      <div key={entry.key} className="kv-row">
                        <span className="kv-key mono">{entry.key}</span>
                        <span className="kv-value mono">{entry.value}</span>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </>
          ) : null}
        </div>

        <footer className="dialog-foot">
          <label className="switch">
            <input
              type="checkbox"
              checked={essentialOnly}
              onChange={(event) => setEssentialOnly(event.target.checked)}
            />
            <span>仅显示关键项</span>
          </label>
          <span className="spacer" />
          <button className="btn" disabled={!info} onClick={copyRaw}>
            <DialogIcon name="copy" size={13} />
            复制完整 INFO
          </button>
          <button className="btn-primary btn" onClick={onClose}>
            <DialogIcon name="cancel" size={13} />
            关闭
          </button>
        </footer>
      </div>
    </div>
  )
}

export default VersionInfoDialog
