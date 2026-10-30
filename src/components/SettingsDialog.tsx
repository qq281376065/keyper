import { useEffect, useState } from 'react'
import { api } from '@/api'
import { DialogShell } from '@/components/DialogShell'
import { DialogIcon } from '@/components/DialogIcon'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { settingsHolder, useSettings, UI_FONTS, MONO_FONTS } from '@/services/settings'
import { setThemeMode, useTheme, type ThemeMode } from '@/services/theme'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { globalHolder } from '@/store/global'

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
const THEMES: Array<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
]
const SKINS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'ocean', label: '深海' },
  { value: 'forest', label: '墨林' },
  { value: 'solarized', label: '暖纸' },
  { value: 'sakura', label: '樱花' },
  { value: 'mint', label: '薄荷' },
  { value: 'mist', label: '雾蓝' },
  { value: 'aurora', label: '极光' },
]

/** 全局设置弹窗：外观 / 数据浏览 / 操作日志三组 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const { settings, save } = useSettings()
  const { mode } = useTheme()
  const { notify } = useRedis()
  useObservable(settingsHolder)
  useObservable(globalHolder)

  const [logPath, setLogPath] = useState('')

  /* 配置文件位置（便携模式可能回退到系统目录，需要如实展示） */
  const [configDir, setConfigDir] = useState('')
  const [configPortable, setConfigPortable] = useState(false)
  const [configReason, setConfigReason] = useState<string | null>(null)

  const configNote = !configDir
    ? t('读取中…')
    : configPortable
      ? t('便携模式：配置与日志都在程序目录旁的 config/ 下')
      : t('已回退到系统目录：{reason}', { reason: configReason ?? t('程序目录不可写') })

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
    if (res.ok) notify('ok', res.data.message ?? t('已打开日志目录'))
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
    notify('ok', t('已恢复默认设置'))
  }

  return (
    <DialogShell
      icon="settings"
      title={t('全局设置')}
      description={t('外观、浏览与日志三项偏好，改动立即生效')}
      className="settings-dialog"
      closeOnOverlay
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" className="foot-btn" onClick={() => void resetAll()}>
            <DialogIcon name="reset" size={13} />
            {t('恢复默认')}
          </Button>
          <span className="spacer" />
          <Button type="button" className="foot-btn foot-primary" onClick={onClose}>
            <DialogIcon name="check" size={13} />
            {t('完成')}
          </Button>
        </>
      }
    >
      {/* ---------------------------------------------------- 外观 */}
      <section className="dlg-section">
        <h3 className="dlg-section-title">{t('外观')}</h3>

        <div className="set-row">
          <span className="set-label">{t('主题')}</span>
          <div className="set-control">
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
          </div>
        </div>

        <div className="set-row">
          <span className="set-label">{t('配色皮肤')}</span>
          <div className="set-control">
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
            <span className="set-hint">{t('皮肤自带明暗档')}</span>
          </div>
        </div>

        <div className="set-row">
          <span className="set-label">{t('界面字号')}</span>
          <div className="set-control">
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
            <span className="set-hint">{t('基准字号，其余字号自动推导')}</span>
          </div>
        </div>

        <div className="set-row">
          <label className="set-label" htmlFor="ui-font">
            {t('界面字体')}
          </label>
          <div className="set-control">
            <Select value={settings.uiFont} onValueChange={(next) => void update({ uiFont: next })}>
              <SelectTrigger id="ui-font" className="dlg-select set-select">
                <SelectValue placeholder={t('选择字体')} />
              </SelectTrigger>
              <SelectContent className="dlg-select-menu">
                {UI_FONTS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {t(item.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="set-row">
          <label className="set-label" htmlFor="mono-font">
            {t('代码字体')}
          </label>
          <div className="set-control">
            <Select
              value={settings.monoFont}
              onValueChange={(next) => void update({ monoFont: next })}
            >
              <SelectTrigger id="mono-font" className="dlg-select set-select">
                <SelectValue placeholder={t('选择字体')} />
              </SelectTrigger>
              <SelectContent className="dlg-select-menu">
                {MONO_FONTS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {t(item.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="set-hint mono">Aa 0123</span>
          </div>
        </div>

        <div className="set-row">
          <span className="set-label">{t('界面密度')}</span>
          <div className="set-control">
            <div className="segmented">
              <button
                type="button"
                className={settings.density === 'compact' ? 'on' : ''}
                onClick={() => void update({ density: 'compact' })}
              >
                {t('紧凑')}
              </button>
              <button
                type="button"
                className={settings.density === 'cozy' ? 'on' : ''}
                onClick={() => void update({ density: 'cozy' })}
              >
                {t('舒适')}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------- 数据浏览 */}
      <section className="dlg-section">
        <h3 className="dlg-section-title">{t('数据浏览')}</h3>

        <div className="set-row">
          <span className="set-label">{t('每页加载键数')}</span>
          <div className="set-control">
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
            <span className="set-hint">{t('单次 SCAN 的 COUNT')}</span>
          </div>
        </div>

        <div className="set-row">
          <span className="set-label">{t('键名分隔符')}</span>
          <div className="set-control">
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
            <span className="set-hint">{t('树形视图的默认分层符号')}</span>
          </div>
        </div>

        <div className="set-row">
          <span className="set-label">{t('删除键前确认')}</span>
          <div className="set-control">
            <div className="segmented">
              <button
                type="button"
                className={settings.confirmDelete ? 'on' : ''}
                onClick={() => void update({ confirmDelete: true })}
              >
                {t('开启')}
              </button>
              <button
                type="button"
                className={!settings.confirmDelete ? 'on' : ''}
                onClick={() => void update({ confirmDelete: false })}
              >
                {t('关闭')}
              </button>
            </div>
            <span className="set-hint">{t('关闭后删除立即生效，不可撤销')}</span>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------- 操作日志 */}
      <section className="dlg-section">
        <h3 className="dlg-section-title">{t('操作日志')}</h3>

        <div className="set-row">
          <span className="set-label">{t('保留天数')}</span>
          <div className="set-control">
            <div className="segmented">
              {RETENTIONS.map((days) => (
                <button
                  key={days}
                  type="button"
                  className={settings.logRetentionDays === days ? 'on' : ''}
                  onClick={() => void update({ logRetentionDays: days })}
                >
                  {t('{days} 天', { days })}
                </button>
              ))}
            </div>
            <span className="set-hint">{t('超期文件在启动或写入时自动清理')}</span>
          </div>
        </div>

        {/*
          路径行：标签在左，路径块独占右侧整宽（min-width: 0 让它能省略）。
          路径是长字符串且含本地用户名，必须能省略 —— 撑破布局比显示不全更糟。
        */}
        <div className="set-row is-block">
          <span className="set-label">{t('配置文件')}</span>
          <div className="set-control is-block">
            <div className="path-box">
              <span className="path mono" title={configDir}>
                {configDir || '—'}
              </span>
              <Button
                type="button"
                variant="outline"
                className="foot-btn path-open"
                onClick={() => void openLogDir()}
              >
                <DialogIcon name="folder-open" size={12} />
                {t('打开目录')}
              </Button>
            </div>
            {/*
              便携模式可能因目录不可写而回退到系统目录，
              这里如实说明 —— 否则用户会疑惑"为什么配置文件不在程序目录里"。
            */}
            <span className="set-hint">{configNote}</span>
          </div>
        </div>

        <div className="set-row is-block">
          <span className="set-label">{t('日志目录')}</span>
          <div className="set-control is-block">
            <div className="path-box">
              <span className="path mono" title={logPath}>
                {logPath || '—'}
              </span>
              <Button
                type="button"
                variant="outline"
                className="foot-btn path-open"
                onClick={() => void openLogDir()}
              >
                <DialogIcon name="folder-open" size={12} />
                {t('打开目录')}
              </Button>
            </div>
          </div>
        </div>

        <p className="set-note">
          {t('仅记录手动操作（命令、键的增删改、连接与配置变更）。文件名格式')}{' '}
          <code className="mono">yyyymmdd.log</code>
          {t('，单行一条便于 grep。')}
        </p>
      </section>
    </DialogShell>
  )
}

export default SettingsDialog
