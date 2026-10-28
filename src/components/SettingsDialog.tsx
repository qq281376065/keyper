import { useEffect, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useDialogDrag } from '@/hooks/useDialogDrag'
import { settingsHolder, useSettings, UI_FONTS, MONO_FONTS } from '@/services/settings'
import { setThemeMode, useTheme, type ThemeMode } from '@/services/theme'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { globalHolder } from '@/store/global'

const FONT_SIZES = [12, 13, 14, 15, 16]
const PAGE_SIZES = [100, 200, 500, 1000]
const SEPARATORS = [':', '/', '.', '-']
const RETENTIONS = [7, 30, 90, 180]
/* 明暗档位与配色皮肤分两行 segmented：9 项挤一行放不下，且两组语义本就不同 */
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
    ? '读取中…'
    : configPortable
      ? '便携模式：配置与日志都在程序目录旁的 config/ 下'
      : `已回退到系统目录：${configReason ?? '程序目录不可写'}`

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
    if (res.ok) notify('ok', res.data.message ?? '已打开日志目录')
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
    notify('ok', '已恢复默认设置')
  }

  const { style, onDragStart } = useDialogDrag()

  return (
    <div className="mask s-settings-dialog">
      <div className="dialog" style={style}>
        <header className="dialog-head" onMouseDown={onDragStart}>
          <span>全局设置</span>
          <span className="spacer" />
          <button className="btn-ghost tiny" onClick={onClose}>
            <DialogIcon name="cancel" size={12} />
          </button>
        </header>

        <div className="dialog-body">
          {/* ---------------------------------------------------- 外观 */}
          <section className="group">
            <h3>外观</h3>

            <div className="row">
              <span className="row-label">主题</span>
              <div className="segmented">
                {THEMES.map((item) => (
                  <button key={item.value} className={mode === item.value ? 'on' : ''} onClick={() => setThemeMode(item.value)}>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="row">
              <span className="row-label">配色皮肤</span>
              <div className="segmented">
                {SKINS.map((item) => (
                  <button key={item.value} className={mode === item.value ? 'on' : ''} onClick={() => setThemeMode(item.value)}>
                    {item.label}
                  </button>
                ))}
              </div>
              <span className="row-hint">皮肤自带明暗档</span>
            </div>

            <div className="row">
              <span className="row-label">界面字号</span>
              <div className="segmented">
                {FONT_SIZES.map((size) => (
                  <button key={size} className={settings.fontSize === size ? 'on' : ''} onClick={() => void update({ fontSize: size })}>
                    {size}
                  </button>
                ))}
              </div>
              <span className="row-hint">基准字号，其余字号自动推导</span>
            </div>

            <div className="row">
              <label className="row-label" htmlFor="ui-font">
                界面字体
              </label>
              <select
                id="ui-font"
                value={settings.uiFont}
                onChange={(event) => void update({ uiFont: event.target.value })}
              >
                {UI_FONTS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="row">
              <label className="row-label" htmlFor="mono-font">
                代码字体
              </label>
              <select
                id="mono-font"
                value={settings.monoFont}
                onChange={(event) => void update({ monoFont: event.target.value })}
              >
                {MONO_FONTS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <span className="row-hint preview mono">Aa 0123</span>
            </div>

            <div className="row">
              <span className="row-label">界面密度</span>
              <div className="segmented">
                <button className={settings.density === 'compact' ? 'on' : ''} onClick={() => void update({ density: 'compact' })}>
                  紧凑
                </button>
                <button className={settings.density === 'cozy' ? 'on' : ''} onClick={() => void update({ density: 'cozy' })}>
                  舒适
                </button>
              </div>
            </div>
          </section>

          {/* ---------------------------------------------------- 数据浏览 */}
          <section className="group">
            <h3>数据浏览</h3>

            <div className="row">
              <span className="row-label">每页加载键数</span>
              <div className="segmented">
                {PAGE_SIZES.map((size) => (
                  <button key={size} className={settings.pageSize === size ? 'on' : ''} onClick={() => void update({ pageSize: size })}>
                    {size}
                  </button>
                ))}
              </div>
              <span className="row-hint">单次 SCAN 的 COUNT</span>
            </div>

            <div className="row">
              <span className="row-label">键名分隔符</span>
              <div className="segmented">
                {SEPARATORS.map((sep) => (
                  <button
                    key={sep}
                    className={`mono${settings.keySeparator === sep ? ' on' : ''}`}
                    onClick={() => void update({ keySeparator: sep })}
                  >
                    {sep}
                  </button>
                ))}
              </div>
              <span className="row-hint">树形视图的默认分层符号</span>
            </div>

            <div className="row">
              <span className="row-label">删除键前确认</span>
              <div className="segmented">
                <button className={settings.confirmDelete ? 'on' : ''} onClick={() => void update({ confirmDelete: true })}>
                  开启
                </button>
                <button className={!settings.confirmDelete ? 'on' : ''} onClick={() => void update({ confirmDelete: false })}>
                  关闭
                </button>
              </div>
              <span className="row-hint">关闭后删除立即生效，不可撤销</span>
            </div>
          </section>

          {/* ---------------------------------------------------- 操作日志 */}
          <section className="group">
            <h3>操作日志</h3>

            <div className="row">
              <span className="row-label">保留天数</span>
              <div className="segmented">
                {RETENTIONS.map((days) => (
                  <button
                    key={days}
                    className={settings.logRetentionDays === days ? 'on' : ''}
                    onClick={() => void update({ logRetentionDays: days })}
                  >
                    {days} 天
                  </button>
                ))}
              </div>
              <span className="row-hint">超期文件在启动或写入时自动清理</span>
            </div>

            <div className="row">
              <span className="row-label">配置文件</span>
              <div className="path-box">
                <span className="path mono ellipsis" {...tipProps(configDir)}>
                  {configDir || '—'}
                </span>
                <button className="btn tiny" onClick={() => void openLogDir()}>
                  <DialogIcon name="folder-open" size={12} />
                  打开目录
                </button>
              </div>
              {/*
                便携模式可能因目录不可写而回退到系统目录，
                这里如实说明 —— 否则用户会疑惑"为什么配置文件不在程序目录里"。
              */}
              <span className="row-hint">{configNote}</span>
            </div>

            <div className="row">
              <span className="row-label">日志目录</span>
              <div className="path-box">
                <span className="path mono ellipsis" {...tipProps(logPath)}>
                  {logPath || '—'}
                </span>
                <button className="btn tiny" onClick={() => void openLogDir()}>
                  <DialogIcon name="folder-open" size={12} />
                  打开目录
                </button>
              </div>
            </div>

            <p className="note">
              仅记录手动操作（命令、键的增删改、连接与配置变更）。 文件名格式 <code className="mono">yyyymmdd.log</code>
              ，单行一条便于 grep。
            </p>
          </section>
        </div>

        <footer className="dialog-foot">
          {/* 与右侧「完成」同一尺寸（都是 .btn，不用 .tiny） */}
          <button className="btn" onClick={() => void resetAll()}>
            <DialogIcon name="reset" size={13} />
            恢复默认
          </button>
          <span className="spacer" />
          <button className="btn-primary btn" onClick={onClose}>
            <DialogIcon name="check" size={13} />
            完成
          </button>
        </footer>
      </div>
    </div>
  )
}

export default SettingsDialog
