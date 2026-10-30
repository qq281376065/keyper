import { useEffect, useRef, useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { useSettings } from '@/services/settings'
import { useSettingsHolder } from '@/hooks/useSettingsHolder'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { globalHolder } from '@/store/global'
import { useI18n } from '@/i18n'

/**
 * 高危命令：执行前必须输入命令名确认。
 * 这类命令会清空整实例 / 整库数据，误执行的代价不可逆，
 * 因此不接受"点一下确认"这种软提示，必须逐字敲入命令名。
 */
const DESTRUCTIVE_COMMANDS = ['FLUSHALL', 'FLUSHDB', 'SHUTDOWN']

/**
 * CLI 控制台（底部抽屉，默认收起）。
 *
 * 命令历史（上下键回溯）存放在会话 state（cliHistory / cliHistoryIndex）：
 * 多标签下每个标签有独立的历史与游标 —— 在 A 标签敲过的命令，
 * 切到 B 标签的上键不应再现。面板本体全局唯一，数据跟标签走。
 */
export function CliConsole() {
  const { state, runCli, clearCli, askConfirm } = useRedis()
  const { t } = useI18n()
  useObservable(globalHolder)
  useObservable(useSettingsHolder())

  const [input, setInput] = useState('')
  const { settings, save: saveSettings } = useSettings()

  /**
   * 控制台展开状态取自设置（默认收起）。
   *
   * 命令行是低频能力 —— 绝大多数操作都能在图形界面完成。
   * 常驻展开会持续占用底部约 1/4 的垂直空间，挤压键列表与值查看区，
   * 因此默认收起；但用户的展开偏好应当记住，不必每次重开。
   */
  const [collapsed, setCollapsed] = useState(settings.cliCollapsed)

  /*
   * 设置是异步加载的（主进程读盘），而组件在首次挂载时必然拿到默认值。
   * 等设置真正到位后补一次同步；`userTouched` 标记避免反向污染 ——
   * 只有"设置变了、而本地还没被用户改过"时才跟随。
   */
  const userTouched = useRef(false)
  useEffect(() => {
    if (userTouched.current) return
    setCollapsed(settings.cliCollapsed)
  }, [settings.cliCollapsed])

  function onToggle(): void {
    userTouched.current = true
    const next = !collapsed
    setCollapsed(next)
    // 展开状态写回设置（用户操作才写，避免初始化时用默认值覆盖磁盘上的值）
    void saveSettings({ cliCollapsed: next })
  }

  const logRef = useRef<HTMLDivElement | null>(null)

  const active = state.connections.find((item) => item.id === state.activeId)
  const connected = active?.status === 'connected'
  const prompt = active ? `${active.host}:${active.port}>` : 'redis>'

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.cliEntries.length])

  async function submit(): Promise<void> {
    const command = input.trim()
    if (!command || !connected) return

    // 高危命令拦截：短语确认通过后才真正下发
    const head = command.split(/\s+/)[0]?.toUpperCase() ?? ''
    if (DESTRUCTIVE_COMMANDS.includes(head)) {
      const confirmed = await askConfirm({
        title: t('cliConsole.commandHighRiskOperation', { command: head }),
        message:
          t('cliConsole.commandWipesAllDataCurrent', { command: head }) +
          '\n\n' +
          t('cliConsole.continueTypeCommandFullBox', { command: head }),
        confirmText: t('cliConsole.executeCommand', { command: head }),
        requirePhrase: head,
        danger: true,
      })

      if (!confirmed) {
        state.cliEntries.push({ kind: 'output', text: t('cliConsole.cancelledRunningCommand', { command: head }) })
        return
      }
    }

    state.cliHistory.push(command)
    state.cliHistoryIndex = state.cliHistory.length
    setInput('')
    await runCli(command)
  }

  function handleKeydown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowUp') {
      if (!state.cliHistory.length) return
      state.cliHistoryIndex = Math.max(0, state.cliHistoryIndex - 1)
      setInput(state.cliHistory[state.cliHistoryIndex] ?? '')
      event.preventDefault()
    } else if (event.key === 'ArrowDown') {
      if (!state.cliHistory.length) return
      state.cliHistoryIndex = Math.min(state.cliHistory.length, state.cliHistoryIndex + 1)
      setInput(state.cliHistory[state.cliHistoryIndex] ?? '')
      event.preventDefault()
    }
  }

  return (
    <section className={`cli${collapsed ? ' collapsed' : ''} s-cli-console`}>
      <header className="cli-head" onClick={onToggle}>
        <span className="chevron">{collapsed ? '▲' : '▼'}</span>
        <span className="title">{t('cliConsole.cliConsole')}</span>
        <span className="hint">{connected ? prompt : t('cliConsole.notConnected')}</span>
        <span className="spacer" />
        {/* 收起时隐藏「清空」：此时看不到日志，清空是个没有反馈的盲操作 */}
        {!collapsed ? (
          <button
            className="btn btn-ghost tiny"
            onClick={(event) => {
              event.stopPropagation()
              clearCli()
            }}
          >
            <DialogIcon name="clear" size={12} />
            {t('common.clear')}
          </button>
        ) : null}
      </header>

      <div className="cli-body" style={collapsed ? { display: 'none' } : undefined}>
        <div ref={logRef} className="cli-log mono">
          {state.cliEntries.map((entry, index) => (
            <div key={index} className={`entry ${entry.kind}`}>
              {entry.kind === 'input' ? <span className="prefix">{prompt}</span> : null}
              <span className="text">{entry.text}</span>
              {entry.costMs != null ? <span className="cost">{entry.costMs}ms</span> : null}
            </div>
          ))}
        </div>

        <div className="cli-input-row">
          <span className="prefix mono">{prompt}</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className="mono"
            disabled={!connected || state.cliRunning}
            placeholder={connected ? t('cliConsole.enterRedisCommandBrowseHistory') : t('cliConsole.connectFirst')}
            onKeyUp={(event) => {
              if (event.key === 'Enter') void submit()
            }}
            onKeyDown={handleKeydown}
          />
          {/* btn 基类不可省：flex 居中只在 .btn 上 —— 只写 btn-primary 会让图标坐在文字 baseline 上 */}
          <button className="btn btn-primary tiny" disabled={!connected || !input.trim()} onClick={() => void submit()}>
            <DialogIcon name="play" size={12} />
            {t('cliConsole.execute')}
          </button>
        </div>
      </div>
    </section>
  )
}

export default CliConsole
