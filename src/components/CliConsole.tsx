import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { LuaScriptDialog } from '@/components/LuaScriptDialog'
import { tipProps } from '@/components/tip'
import { useSettings } from '@/services/settings'
import { useSettingsHolder } from '@/hooks/useSettingsHolder'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { globalHolder } from '@/store/global'
import { useSessionStore } from '@/hooks/useSessionStore'
import { useI18n } from '@/i18n'
import { buildCliSuggestions, type CliSuggestion } from '@/utils/cliSuggest'
import { copyText } from '@/utils/clipboard'

/**
 * 高危命令：执行前必须输入命令名确认。
 * 这类命令会清空整实例 / 整库数据，误执行的代价不可逆，
 * 因此不接受"点一下确认"这种软提示，必须逐字敲入命令名。
 */
const DESTRUCTIVE_COMMANDS = ['FLUSHALL', 'FLUSHDB', 'SHUTDOWN', 'SCRIPT FLUSH']

/**
 * CLI 控制台（底部抽屉，默认收起）。
 *
 * 命令历史（上下键回溯）存放在会话 state（cliHistory / cliHistoryIndex）：
 * 多标签下每个标签有独立的历史与游标 —— 在 A 标签敲过的命令，
 * 切到 B 标签的上键不应再现。面板本体全局唯一，数据跟标签走。
 */
export function CliConsole() {
  const { state, runCli, clearCli, askConfirm, notify } = useRedis()
  const { t } = useI18n()
  useObservable(globalHolder)
  useObservable(useSettingsHolder())
  /* 组件挂在标签树外，CLI 日志/运行态写的是当前会话 store，必须一并订阅 */
  useObservable(useSessionStore())

  const [input, setInput] = useState('')
  const [suggestIndex, setSuggestIndex] = useState(0)
  const [suggestDismissed, setSuggestDismissed] = useState(false)
  const [historySearch, setHistorySearch] = useState(false)
  const [historyIndex, setHistoryIndex] = useState(0)
  const [luaOpen, setLuaOpen] = useState(false)
  const suppressSubmit = useRef(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
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

  const suggestions = useMemo(
    () => buildCliSuggestions(input, state.keys.map((item) => item.key)),
    [input, state.keys],
  )
  const showSuggest =
    !collapsed &&
    connected &&
    !state.cliRunning &&
    !suggestDismissed &&
    suggestions.length > 0 &&
    input.trim().length > 0

  const historyMatches = useMemo(() => {
    const query = input.trim().toLowerCase()
    return state.cliHistory
      .slice()
      .reverse()
      .filter((command) => !query || command.toLowerCase().includes(query))
  }, [input, state.cliHistory])

  /* 补全历史按连接持久化：切标签时合并到本标签的会话历史 */
  useEffect(() => {
    const connId = state.activeId
    if (!connId) return
    let cancelled = false
    void api.cliHistory.get(connId).then((res) => {
      if (cancelled || !res.ok || state.activeId !== connId) return
      const seen = new Set(state.cliHistory.map((cmd) => cmd.toLowerCase()))
      const persisted = res.data
        .slice()
        .reverse()
        .filter((cmd) => !seen.has(cmd.toLowerCase()))
      state.cliHistory = [...persisted, ...state.cliHistory]
      state.cliHistoryIndex = state.cliHistory.length
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeId])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.cliEntries.length])

  async function submit(): Promise<void> {
    const command = input.trim()
    if (!command || !connected) return

    // 高危命令拦截：短语确认通过后才真正下发
    const parts = command.split(/\s+/)
    const head = parts[0]?.toUpperCase() ?? ''
    const commandPhrase = parts.length > 1 ? `${head} ${parts[1].toUpperCase()}` : head
    const destructive = DESTRUCTIVE_COMMANDS.find((item) =>
      item.includes(' ') ? commandPhrase === item : head === item,
    )
    if (destructive) {
      const confirmed = await askConfirm({
        title: t('cliConsole.commandHighRiskOperation', { command: destructive }),
        message:
          t('cliConsole.commandWipesAllDataCurrent', { command: destructive }) +
          '\n\n' +
          t('cliConsole.continueTypeCommandFullBox', { command: destructive }),
        confirmText: t('cliConsole.executeCommand', { command: destructive }),
        requirePhrase: destructive,
        danger: true,
      })

      if (!confirmed) {
        state.cliEntries.push({ kind: 'output', text: t('cliConsole.cancelledRunningCommand', { command: destructive }) })
        return
      }
    }

    state.cliHistory.push(command)
    state.cliHistoryIndex = state.cliHistory.length
    if (state.activeId) void api.cliHistory.record(state.activeId, command)
    setInput('')
    setSuggestDismissed(false)
    setSuggestIndex(0)
    setHistorySearch(false)
    await runCli(command)
  }

  function acceptSuggestion(item: CliSuggestion): void {
    setInput(item.value)
    setSuggestIndex(0)
    setSuggestDismissed(false)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  function acceptHistory(command: string): void {
    setInput(command)
    setHistorySearch(false)
    setHistoryIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  function closeSuggest(): void {
    if (historySearch) setHistorySearch(false)
    else setSuggestDismissed(true)
  }

  function handleKeydown(event: React.KeyboardEvent): void {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return

    if (event.key.toLowerCase() === 'r' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      setHistorySearch(true)
      setHistoryIndex(0)
      setSuggestDismissed(true)
      return
    }

    if (historySearch) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHistoryIndex((index) => (index + 1) % Math.max(historyMatches.length, 1))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHistoryIndex(
          (index) => (index - 1 + Math.max(historyMatches.length, 1)) % Math.max(historyMatches.length, 1),
        )
        return
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        const command = historyMatches[historyIndex]
        if (command) {
          event.preventDefault()
          if (event.key === 'Enter') suppressSubmit.current = true
          acceptHistory(command)
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setHistorySearch(false)
        return
      }
    }

    if (showSuggest) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSuggestIndex((index) => (index + 1) % suggestions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSuggestIndex((index) => (index - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        const item = suggestions[suggestIndex]
        if (item) acceptSuggestion(item)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSuggestDismissed(true)
        return
      }
    }

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

  function timeLabel(at?: number): string {
    if (!at) return ''
    const date = new Date(at)
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  async function exportLog(): Promise<void> {
    const lines = state.cliEntries.map((entry) => {
      const time = entry.at ? `[${timeLabel(entry.at)}] ` : ''
      const marker = entry.kind === 'input' ? '>' : entry.kind === 'error' ? '!' : '<'
      const cost = entry.costMs != null ? ` (${entry.costMs}ms)` : ''
      return `${time}${marker} ${entry.text}${cost}`
    })
    const host = active ? `${active.host}-${active.port}` : 'redis'
    const res = await api.file.saveText({
      suggestedName: `cli-${host}-${Date.now()}.log`,
      content: lines.join('\n'),
    })
    if (!res.ok) notify('err', res.error)
    else if (res.data.saved) notify('ok', t('cliConsole.exportLogDone'))
  }

  async function copyEntry(text: string): Promise<void> {
    const done = await copyText(text)
    if (!done) notify('err', t('common.copyFailedCheckClipboardPermissions'))
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
          <>
            <button
              className="btn btn-ghost tiny"
              disabled={!connected}
              onClick={(event) => {
                event.stopPropagation()
                setLuaOpen(true)
              }}
            >
              <DialogIcon name="code" size={12} />
              Lua
            </button>
            <button
              className="btn btn-ghost tiny"
              disabled={!state.cliEntries.length}
              onClick={(event) => {
                event.stopPropagation()
                void exportLog()
              }}
            >
              <DialogIcon name="export" size={12} />
              {t('cliConsole.exportLog')}
            </button>
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
          </>
        ) : null}
      </header>

      <div className="cli-body" style={collapsed ? { display: 'none' } : undefined}>
        <div ref={logRef} className="cli-log mono">
          {state.cliEntries.map((entry, index) => (
            <div key={index} className={`entry ${entry.kind}`}>
              {entry.kind === 'input' ? <span className="prefix">{prompt}</span> : null}
              <span className="text">{entry.text}</span>
              {entry.costMs != null ? <span className="cost">{entry.costMs}ms</span> : null}
              {entry.at ? <span className="at">{timeLabel(entry.at)}</span> : null}
              <button
                className="entry-copy"
                {...tipProps(t('common.copy'))}
                onClick={() => void copyEntry(entry.text)}
              >
                <DialogIcon name="copy" size={10} />
              </button>
            </div>
          ))}
        </div>

        <div className="cli-input-row">
          {historySearch ? (
            <div className="cli-suggest">
              <div className="cli-suggest-head">
                <span className="csh-grip" aria-hidden="true" />
                <span className="csh-title">{t('cliSuggest.historyTitle')}</span>
                <span className="spacer" />
                <button className="csh-close" {...tipProps(t('cliSuggest.close'))} onClick={closeSuggest}>
                  <DialogIcon name="cancel" size={10} />
                </button>
              </div>
              {historyMatches.length ? (
                historyMatches.map((command, index) => (
                  <button
                    key={`${command}-${index}`}
                    className={`cli-suggest-item${index === historyIndex ? ' sel' : ''}`}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      acceptHistory(command)
                    }}
                  >
                    <span className="cs-tag cs-history">{t('cliSuggest.history')}</span>
                    <span className="cs-label mono">{command}</span>
                  </button>
                ))
              ) : (
                <div className="cli-suggest-empty">{t('cliSuggest.noHistory')}</div>
              )}
            </div>
          ) : showSuggest ? (
            <div className="cli-suggest">
              <div className="cli-suggest-head">
                <span className="csh-grip" aria-hidden="true" />
                <span className="csh-title">{t('cliSuggest.title')}</span>
                <span className="spacer" />
                <button className="csh-close" {...tipProps(t('cliSuggest.close'))} onClick={closeSuggest}>
                  <DialogIcon name="cancel" size={10} />
                </button>
              </div>
              {suggestions.map((item, index) => (
                <button
                  key={`${item.kind}-${item.label}`}
                  className={`cli-suggest-item${index === suggestIndex ? ' sel' : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    acceptSuggestion(item)
                  }}
                >
                  <span className={`cs-tag cs-${item.kind}`}>
                    {item.kind === 'command'
                      ? t('cliSuggest.command')
                      : item.kind === 'subcommand'
                        ? t('cliSuggest.subcommand')
                        : t('cliSuggest.key')}
                  </span>
                  <span className="cs-label mono">{item.label}</span>
                  {item.readonly ? <span className="cs-ro">{t('cliSuggest.readonly')}</span> : null}
                  {item.group || item.since ? (
                    <span className="cs-detail">
                      {t('cliSuggest.detail', {
                        group: item.group ?? '',
                        since: item.since ?? '',
                      })}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          <span className="prefix mono">{prompt}</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(event) => {
              setInput(event.target.value)
              setSuggestIndex(0)
              setHistoryIndex(0)
              setSuggestDismissed(false)
            }}
            className="mono"
            disabled={!connected || state.cliRunning}
            placeholder={connected ? t('cliConsole.enterRedisCommandBrowseHistory') : t('cliConsole.connectFirst')}
            onKeyUp={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              if (suppressSubmit.current) {
                suppressSubmit.current = false
                return
              }
              void submit()
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
      {luaOpen ? <LuaScriptDialog onClose={() => setLuaOpen(false)} /> : null}
    </section>
  )
}

export default CliConsole
