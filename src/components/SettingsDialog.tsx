import { useEffect, useState } from 'react'
import { api } from '@/api'
import { DialogShell } from '@/components/DialogShell'
import { DialogIcon, type DialogIconName } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useI18n } from '@/i18n'
import type { MsgKey } from '@shared/i18n'
import { settingsHolder, useSettings, UI_FONTS, MONO_FONTS } from '@/services/settings'
import { setThemeMode, useTheme, type ThemeMode } from '@/services/theme'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { globalHolder } from '@/store/global'
import type { ProxyMode } from '@shared/types'

const FONT_SIZES = [12, 13, 14, 15, 16]
const PAGE_SIZES = [100, 200, 500, 1000]
/*
 * 常见键名分隔符。
 *
 * `_` 与 `-` 都属于「扁平命名」场景：`user_profile_name`、`order-2024-01`。
 * 它们不是层级结构的分隔符，但用户确实按这个粒度组织键名 —— 用它们建树
 * 能把一长串同族键归到一个目录下，比平铺更容易扫读。
 *
 * 注意 tree 侧对这两种字符没有特殊处理：buildKeyTree 只是按分隔符切段，
 * 空段（如 `a__b`）会退化成根级节点，不会产生错误的层级。
 */
const SEPARATORS = [':', '/', '.', '-', '_']
const RETENTIONS = [7, 30, 90, 180]
/* 明暗档位与配色皮肤分两行：9 项挤一行放不下，且两组语义本就不同 */
const THEMES: Array<{ value: ThemeMode; label: MsgKey }> = [
  { value: 'system', label: 'theme.followSystem' },
  { value: 'light', label: 'theme.light' },
  { value: 'dark', label: 'theme.dark' },
]
const SKINS: Array<{ value: ThemeMode; label: MsgKey }> = [
  { value: 'ocean', label: 'theme.ocean' },
  { value: 'phosphor', label: 'theme.phosphor' },
  { value: 'solarized', label: 'theme.solarized' },
  { value: 'sakura', label: 'theme.sakura' },
  { value: 'mint', label: 'theme.mint' },
  { value: 'mist', label: 'theme.mist' },
  { value: 'berry', label: 'theme.berry' },
]

/**
 * 侧栏导航分组（方案 A · side-panel）。
 * count 是该组设置项数量，徽标展示；新增设置项时同步更新。
 */
type GroupId = 'appearance' | 'browser' | 'network' | 'logs'
const GROUPS: Array<{ id: GroupId; icon: DialogIconName; label: MsgKey; sub: MsgKey; count: number }> = [
  { id: 'appearance', icon: 'theme', label: 'settingsDialog.appearance', sub: 'settingsDialog.groupAppearanceSub', count: 6 },
  { id: 'browser', icon: 'list', label: 'settingsDialog.dataBrowser', sub: 'settingsDialog.groupBrowserSub', count: 3 },
  { id: 'network', icon: 'globe', label: 'settingsDialog.networkProxy', sub: 'settingsDialog.groupNetworkSub', count: 2 },
  { id: 'logs', icon: 'document', label: 'common.activityLog', sub: 'settingsDialog.groupLogsSub', count: 3 },
]

/**
 * 全局设置弹窗 —— 侧栏导航布局（方案 A）。
 *
 * 左侧分组导航（图标 + 计数徽标 + 强调色指示条），右侧只显示当前组：
 * 每组一屏，不再四组长滚动。头尾仍是 DialogShell（拖拽 / 页脚 / 居中不变），
 * 正文用负外边距抵消 .dlg-body 的内边距，让侧栏底色贴到弹窗边缘。
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const { settings, save } = useSettings()
  const { mode } = useTheme()
  const { notify } = useRedis()
  useObservable(settingsHolder)
  useObservable(globalHolder)

  const [group, setGroup] = useState<GroupId>('appearance')
  const [logPath, setLogPath] = useState('')

  /* 配置文件位置（便携模式可能回退到系统目录，需要如实展示） */
  const [configDir, setConfigDir] = useState('')
  const [configPortable, setConfigPortable] = useState(false)
  const [configReason, setConfigReason] = useState<string | null>(null)

  const configNote = !configDir
    ? t('common.loading')
    : configPortable
      ? t('settingsDialog.portableMode')
      : t('settingsDialog.fellBackSystemDirectory', { reason: configReason ?? t('settingsDialog.appDirectoryNotWritable') })

  useEffect(() => {
    void (async () => {
      const [dirRes, infoRes] = await Promise.all([api.log.dir(), api.settings.configInfo()])
      if (dirRes.ok) setLogPath(dirRes.data)
      if (infoRes.ok) {
        setConfigDir(infoRes.data.dir)
        setConfigPortable(infoRes.data.portable)
        setConfigReason(infoRes.data.reason ?? null)
      }
    })()
  }, [])

  async function update(patch: Parameters<typeof save>[0]): Promise<void> {
    await save(patch)
  }

  async function openLogDir(): Promise<void> {
    const res = await api.log.openDir()
    if (res.ok) notify('ok', res.data.message ?? t('common.openedLogDirectory'))
    else notify('err', res.error)
  }

  async function resetAll(): Promise<void> {
    await save({
      fontSize: 13,
      uiFont: 'system',
      monoFont: 'jetbrains-mono',
      density: 'compact',
      pageSize: 200,
      keySeparator: ':',
      confirmDelete: true,
      logRetentionDays: 30,
    })
    setThemeMode('system')
    notify('ok', t('settingsDialog.defaultSettingsRestored'))
  }

  /* ---------------------------------------------------- 网络代理（更新通道） */
  /* 地址草稿：输入过程不落盘，失焦 / 回车才提交（避免每键一次 IPC + 代理重配） */
  const [proxyDraft, setProxyDraft] = useState(settings.proxy.url)
  const [detecting, setDetecting] = useState(false)
  const [detectNote, setDetectNote] = useState<string | null>(null)
  /* 外部保存（如自动检测填充）后同步草稿；用户正在输入时不覆盖 */
  const [proxyFocused, setProxyFocused] = useState(false)
  useEffect(() => {
    if (!proxyFocused) setProxyDraft(settings.proxy.url)
  }, [settings.proxy.url, proxyFocused])

  async function setProxyMode(next: ProxyMode): Promise<void> {
    /* 切到手动时带上当前草稿地址；切走时保留地址以便切回 */
    await save({ proxy: { mode: next, url: next === 'manual' ? proxyDraft : settings.proxy.url } })
  }

  async function commitProxyUrl(): Promise<void> {
    const url = proxyDraft.trim()
    if (url === settings.proxy.url) return
    await save({ proxy: { mode: settings.proxy.mode, url } })
  }

  async function detectProxy(): Promise<void> {
    setDetecting(true)
    setDetectNote(null)
    try {
      const res = await api.settings.detectProxy()
      if (!res.ok) throw new Error(res.error)
      if (res.data.found && res.data.url) {
        /* 检测到代理：自动填充并切到手动模式（用户可再改回关闭/系统） */
        setProxyDraft(res.data.url)
        await save({ proxy: { mode: 'manual', url: res.data.url } })
        setDetectNote(
          res.data.source === 'system'
            ? t('settingsDialog.proxyDetectedSystem')
            : res.data.source === 'env'
              ? t('settingsDialog.proxyDetectedEnv')
              : t('settingsDialog.proxyDetectedSession'),
        )
        notify('ok', t('settingsDialog.proxyDetectedFilled'))
      } else {
        setDetectNote(t('settingsDialog.proxyNotFound'))
      }
    } catch (error) {
      notify('err', error instanceof Error ? error.message : t('settingsDialog.proxyDetectFailed'))
    } finally {
      setDetecting(false)
    }
  }

  /* ---------------------------------------------------- 行渲染助手 */
  /** 单行设置：左标签（可带副标题），右控件；底部分隔线 */
  function row(label: string, control: React.ReactNode, sub?: string, block = false) {
    return (
      <div className={`set-nav-row${block ? ' is-block' : ''}`}>
        <div className="set-nav-label">
          {label}
          {sub ? <small>{sub}</small> : null}
        </div>
        <div className="set-nav-control">{control}</div>
      </div>
    )
  }

  const active = GROUPS.find((g) => g.id === group) ?? GROUPS[0]!

  return (
    <DialogShell
      icon="settings"
      title={t('app.settings')}
      description={t('settingsDialog.appearanceBrowsingLogging')}
      className="settings-dialog"
      closeOnOverlay
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" className="foot-btn" onClick={() => void resetAll()}>
            <DialogIcon name="reset" size={13} />
            {t('settingsDialog.restoreDefaults')}
          </Button>
          <span className="spacer" />
          <Button type="button" className="foot-btn foot-primary" onClick={onClose}>
            <DialogIcon name="check" size={13} />
            {t('bulkOpsPanel.done')}
          </Button>
        </>
      }
    >
      <div className="set-layout">
        {/* ---------------- 左侧分组导航 ---------------- */}
        <nav className="set-nav" aria-label={t('app.settings')}>
          {GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`set-nav-item${group === g.id ? ' on' : ''}`}
              onClick={() => setGroup(g.id)}
            >
              <DialogIcon name={g.icon} size={13} />
              <span className="set-nav-name">{t(g.label)}</span>
              <span className="set-nav-count mono">{g.count}</span>
            </button>
          ))}
        </nav>

        {/* ---------------- 右侧当前组 ---------------- */}
        <div className="set-main">
          <h4 className="set-main-title">{t(active.label)}</h4>
          <p className="set-main-sub">{t(active.sub)}</p>

          {group === 'appearance' ? (
            <>
              {row(t('settingsDialog.theme'), (
                <div className="segmented">
                  {THEMES.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={mode === item.value ? 'on' : ''}
                      onClick={() => setThemeMode(item.value)}
                    >
                      {t(item.label)}
                    </button>
                  ))}
                </div>
              ))}
              {row(t('settingsDialog.themeSkin'), (
                <div className="segmented">
                  {SKINS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={mode === item.value ? 'on' : ''}
                      onClick={() => setThemeMode(item.value)}
                    >
                      {t(item.label)}
                    </button>
                  ))}
                </div>
              ), t('settingsDialog.eachSkinLightDarkVariants'), true)}
              {row(t('settingsDialog.fontSize'), (
                <div className="segmented">
                  {FONT_SIZES.map((size) => (
                    <button
                      key={size}
                      type="button"
                      className={settings.fontSize === size ? 'on' : ''}
                      onClick={() => void update({ fontSize: size })}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              ), t('settingsDialog.baseFontSizeOtherSizes'))}
              {row(t('settingsDialog.uiFont'), (
                <Select value={settings.uiFont} onValueChange={(next) => void update({ uiFont: next })}>
                  <SelectTrigger className="dlg-select set-select">
                    <SelectValue placeholder={t('settingsDialog.selectFont')} />
                  </SelectTrigger>
                  <SelectContent className="dlg-select-menu">
                    {UI_FONTS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {t(item.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ))}
              {row(t('settingsDialog.codeFont'), (
                <Select value={settings.monoFont} onValueChange={(next) => void update({ monoFont: next })}>
                  <SelectTrigger className="dlg-select set-select">
                    <SelectValue placeholder={t('settingsDialog.selectFont')} />
                  </SelectTrigger>
                  <SelectContent className="dlg-select-menu">
                    {MONO_FONTS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {t(item.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ))}
              {row(t('settingsDialog.uiDensity'), (
                <div className="segmented">
                  <button
                    type="button"
                    className={settings.density === 'compact' ? 'on' : ''}
                    onClick={() => void update({ density: 'compact' })}
                  >
                    {t('settingsDialog.compact')}
                  </button>
                  <button
                    type="button"
                    className={settings.density === 'cozy' ? 'on' : ''}
                    onClick={() => void update({ density: 'cozy' })}
                  >
                    {t('settingsDialog.comfortable')}
                  </button>
                </div>
              ))}
            </>
          ) : null}

          {group === 'browser' ? (
            <>
              {row(t('settingsDialog.keysLoadedPerPage'), (
                <div className="segmented">
                  {PAGE_SIZES.map((size) => (
                    <button
                      key={size}
                      type="button"
                      className={settings.pageSize === size ? 'on' : ''}
                      onClick={() => void update({ pageSize: size })}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              ), t('settingsDialog.countPerScan'))}
              {row(t('settingsDialog.keyNameDelimiter'), (
                <div className="segmented sep-segmented">
                  {SEPARATORS.map((sep) => (
                    <button
                      key={sep}
                      type="button"
                      className={`mono${settings.keySeparator === sep ? ' on' : ''}`}
                      onClick={() => void update({ keySeparator: sep })}
                    >
                      {sep}
                    </button>
                  ))}
                </div>
              ), t('settingsDialog.defaultHierarchySymbolForTree'))}
              {row(t('settingsDialog.confirmBeforeDeletingKeys'), (
                <div className="segmented">
                  <button
                    type="button"
                    className={settings.confirmDelete ? 'on' : ''}
                    onClick={() => void update({ confirmDelete: true })}
                  >
                    {t('settingsDialog.on')}
                  </button>
                  <button
                    type="button"
                    className={!settings.confirmDelete ? 'on' : ''}
                    onClick={() => void update({ confirmDelete: false })}
                  >
                    {t('common.close')}
                  </button>
                </div>
              ), t('settingsDialog.afterClosingDeletionApplies'))}
            </>
          ) : null}

          {group === 'network' ? (
            <>
              {row(t('settingsDialog.proxyMode'), (
                <div className="segmented">
                  <button
                    type="button"
                    className={settings.proxy.mode === 'off' ? 'on' : ''}
                    onClick={() => void setProxyMode('off')}
                  >
                    {t('settingsDialog.proxyOff')}
                  </button>
                  <button
                    type="button"
                    className={settings.proxy.mode === 'system' ? 'on' : ''}
                    onClick={() => void setProxyMode('system')}
                  >
                    {t('settingsDialog.proxySystem')}
                  </button>
                  <button
                    type="button"
                    className={settings.proxy.mode === 'manual' ? 'on' : ''}
                    onClick={() => void setProxyMode('manual')}
                  >
                    {t('settingsDialog.proxyManual')}
                  </button>
                </div>
              ), t('settingsDialog.proxyScopeHint'))}
              {settings.proxy.mode === 'manual' ? (
                <div className="set-nav-row is-block">
                  <div className="set-nav-label">{t('settingsDialog.proxyAddress')}</div>
                  <div className="set-nav-control is-block">
                    <div className="proxy-address-row">
                      <Input
                        value={proxyDraft}
                        onChange={(event) => setProxyDraft(event.target.value)}
                        onFocus={() => setProxyFocused(true)}
                        onBlur={() => {
                          setProxyFocused(false)
                          void commitProxyUrl()
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void commitProxyUrl()
                          }
                        }}
                        className="mono proxy-input"
                        placeholder="http://127.0.0.1:7890"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="foot-btn proxy-detect"
                        disabled={detecting}
                        onClick={() => void detectProxy()}
                        {...tipProps(t('settingsDialog.proxyDetectHint'))}
                      >
                        <DialogIcon name={detecting ? 'refresh' : 'search'} size={12} className={detecting ? 'spin' : undefined} />
                        {detecting ? t('settingsDialog.proxyDetecting') : t('settingsDialog.proxyDetect')}
                      </Button>
                    </div>
                    <span className="set-hint">
                      {detectNote ?? t('settingsDialog.proxyAddressHint')}
                    </span>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {group === 'logs' ? (
            <>
              {row(t('settingsDialog.retentionDays'), (
                <div className="segmented">
                  {RETENTIONS.map((days) => (
                    <button
                      key={days}
                      type="button"
                      className={settings.logRetentionDays === days ? 'on' : ''}
                      onClick={() => void update({ logRetentionDays: days })}
                    >
                      {t('settingsDialog.days', { days })}
                    </button>
                  ))}
                </div>
              ), t('settingsDialog.expiredFilesCleanedUp'))}
              <div className="set-nav-row is-block">
                <div className="set-nav-label">{t('serverOverview.configFile')}</div>
                <div className="set-nav-control is-block">
                  <div className="path-box">
                    <span className="path mono" {...tipProps(configDir)}>
                      {configDir || '—'}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      className="foot-btn path-open"
                      onClick={() => void openLogDir()}
                    >
                      <DialogIcon name="folder-open" size={12} />
                      {t('settingsDialog.openDirectory')}
                    </Button>
                  </div>
                  <span className="set-hint">{configNote}</span>
                </div>
              </div>
              <div className="set-nav-row is-block">
                <div className="set-nav-label">{t('settingsDialog.logDirectory')}</div>
                <div className="set-nav-control is-block">
                  <div className="path-box">
                    <span className="path mono" {...tipProps(logPath)}>
                      {logPath || '—'}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      className="foot-btn path-open"
                      onClick={() => void openLogDir()}
                    >
                      <DialogIcon name="folder-open" size={12} />
                      {t('settingsDialog.openDirectory')}
                    </Button>
                  </div>
                  <span className="set-hint">
                    {t('settingsDialog.logsManualActionsOnly')}{' '}
                    <code className="mono">yyyymmdd.log</code>
                    {t('settingsDialog.onePerLineForEasy')}
                  </span>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </DialogShell>
  )
}

export default SettingsDialog