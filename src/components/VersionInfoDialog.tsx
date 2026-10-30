import { useEffect, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { DialogShell } from '@/components/DialogShell'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useRedis } from '@/store/useRedis'
import { copyText } from '@/utils/clipboard'
import { parseRedisVersion, resolveCapabilities } from '@/utils/redisCapability'
import type { VersionInfo } from '@shared/types'
import { globalHolder } from '@/store/global'
import { useObservable } from '@/store/subscription'
import { useI18n } from '@/i18n'

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
  const { t } = useI18n()
  /* 订阅全局：toast / 连接列表变化时同步重渲染 */
  useObservable(globalHolder)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [info, setInfo] = useState<VersionInfo | null>(null)
  /** 只看关键项：默认收起次要字段，避免一屏堆几十行 */
  const [essentialOnly, setEssentialOnly] = useState(true)


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
      setError(e instanceof Error ? e.message : t('读取失败'))
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
    notify(done ? 'ok' : 'err', done ? t('已复制完整 INFO 输出') : t('复制失败，请检查剪贴板权限'))
  }

  const capabilities = resolveCapabilities(info?.version)
  const versionParts = parseRedisVersion(info?.version)

  /** 兼容性结论：直接影响界面上哪些功能可用 */
  const compatibility: Array<{ name: string; ok: boolean; note: string }> = []
  if (capabilities.versionKnown) {
    compatibility.push(
      {
        name: t('hash 字段级 TTL'),
        ok: capabilities.hashFieldTtl,
        note: capabilities.hashFieldTtl ? t('HEXPIRE / HTTL 可用') : t('需 Redis 7.4+，当前仅支持键级 TTL'),
      },
      {
        name: t('set 成员级 TTL'),
        ok: capabilities.setMemberTtl,
        note: capabilities.setMemberTtl ? t('SHEXPIRE / STTL 可用') : t('需 Redis 7.4+'),
      },
      {
        name: t('ACL（用户名认证）'),
        ok: (versionParts?.major ?? 0) > 5,
        note: (versionParts?.major ?? 0) > 5 ? t('支持 USER / PASSWORD') : t('需 Redis 6.0+，仅支持密码'),
      },
      {
        name: t('多线程 IO'),
        ok: (versionParts?.major ?? 0) > 5,
        note: (versionParts?.major ?? 0) > 5 ? t('io-threads 可配') : t('需 Redis 6.0+'),
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
    <DialogShell
      icon="info"
      title={t('版本信息')}
      description={t('版本号决定界面可用能力，下方列出本实例的实际支持情况')}
      badge={
        <span className="dlg-badge mono ellipsis">
          {host}:{port}
        </span>
      }
      className="version-info-dialog"
      closeOnOverlay
      onClose={onClose}
      /* 头部右侧的刷新按钮并入页脚 —— 头部只留关闭，避免两个图标按钮挤在一起 */
      footer={
        <>
          <label className="essential-toggle">
            <Switch checked={essentialOnly} onCheckedChange={setEssentialOnly} />
            <span>{t('仅显示关键项')}</span>
          </label>
          <span className="spacer" />
          <Button
            type="button"
            variant="outline"
            className="foot-btn"
            disabled={loading}
            onClick={() => void load()}
          >
            <DialogIcon name="refresh" size={13} />
            {t('刷新')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="foot-btn"
            disabled={!info}
            onClick={() => void copyRaw()}
          >
            <DialogIcon name="copy" size={13} />
            {t('复制 INFO')}
          </Button>
          <Button type="button" className="foot-btn foot-primary" onClick={onClose}>
            <DialogIcon name="check" size={13} />
            {t('关闭')}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="placeholder scan-state">
          <span className="spinner" />
          <span>{t('正在读取 INFO…')}</span>
        </p>
      ) : error ? (
        <div className="dlg-alert is-err" role="status">
          <DialogIcon name="warning" size={14} />
          <span>{error}</span>
        </div>
      ) : info ? (
        <>
          {/* 版本概览：版本号是这一屏的主信息，单独给一块视觉权重 */}
          <section className="vi-hero">
            <span className="vi-version mono">{info.version || t('未知')}</span>
            <span className="vi-mode">{info.mode}</span>
          </section>

          {/* 能力探测：直接对应界面上哪些功能会出现 */}
          {compatibility.length ? (
            <section className="vi-section">
              <h3 className="vi-section-title">{t('能力探测')}</h3>
              <div className="vi-caps">
                {compatibility.map((item) => (
                  <div key={item.name} className={`vi-cap${item.ok ? ' ok' : ''}`}>
                    <span className="vi-cap-mark">
                      <DialogIcon name={item.ok ? 'check' : 'cancel'} size={11} />
                    </span>
                    <span className="vi-cap-name">{item.name}</span>
                    <span className="vi-cap-note">{item.note}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* INFO 分组 */}
          {groups.map((group) => (
            <section key={group.section} className="vi-section">
              <h3 className="vi-section-title">{group.section}</h3>
              <div className="vi-kv">
                {group.entries.map((entry) => (
                  <div key={entry.key} className="vi-kv-row">
                    <span className="vi-kv-key mono">{entry.key}</span>
                    <span className="vi-kv-value mono">{entry.value}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </>
      ) : null}
    </DialogShell>
  )
}

export default VersionInfoDialog
