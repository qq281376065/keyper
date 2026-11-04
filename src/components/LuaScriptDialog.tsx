import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { DialogShell } from '@/components/DialogShell'
import { FilterBox } from '@/components/FilterBox'
import { tipProps } from '@/components/tip'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import type { MsgKey } from '@/i18n'
import { useRedis } from '@/store/useRedis'
import { copyText } from '@/utils/clipboard'
import type { CliResult, LuaScript } from '@shared/types'

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

const NAME_MAX = 80
const NAME_INVALID = /[<>:"/\\|?*\u0000-\u001f]/
const NAME_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 脚本名会直接变成 .lua 文件名，保存前先按同一套规则拦一次，避免只看到主进程的报错 */
function nameProblem(raw: string, scripts: LuaScript[], selectedId: string): MsgKey | null {
  const trimmed = raw.trim()
  if (!trimmed) return 'luaConsole.nameRequired'
  if (trimmed.length > NAME_MAX) return 'luaConsole.nameTooLong'
  if (NAME_INVALID.test(trimmed) || /[. ]$/.test(trimmed) || NAME_RESERVED.test(trimmed)) {
    return 'luaConsole.nameInvalid'
  }
  const lower = trimmed.toLowerCase()
  if (scripts.some((item) => item.id !== selectedId && item.name.toLowerCase() === lower)) {
    return 'luaConsole.nameExists'
  }
  return null
}

/**
 * Lua 控制台。
 *
 * 版式固定为「左侧脚本库 + 右侧工作台」，正文区不滚动 ——
 * 脚本编辑器、参数与结果各自独立滚动。整页滚动会把名称行和脚本列表
 * 卷出视野，是旧版最影响使用的问题。
 */
export function LuaScriptDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const { state, notify, askConfirm, loadKeys } = useRedis()
  const [scripts, setScripts] = useState<LuaScript[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [name, setName] = useState('')
  const [script, setScript] = useState('')
  const [keysText, setKeysText] = useState('')
  const [argsText, setArgsText] = useState('')
  const [readOnly, setReadOnly] = useState(false)
  const [result, setResult] = useState<CliResult | null>(null)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkChecked, setBulkChecked] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const gutterRef = useRef<HTMLDivElement | null>(null)
  const codeWrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void api.luaScripts.list().then((res) => {
      setLoaded(true)
      if (!res.ok) {
        notify('err', res.error)
        return
      }
      setScripts(res.data)
      const first = res.data[0]
      if (first) {
        setSelectedId(first.id)
        setName(first.name)
        setScript(first.script)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = scripts.find((item) => item.id === selectedId)
  const dirty = selected
    ? name.trim() !== selected.name || script !== selected.script
    : name.trim().length > 0 || script.trim().length > 0
  const canSave = !!name.trim() && dirty && !saving
  const lineCount = useMemo(() => Math.max(1, script.split('\n').length), [script])
  const gutterText = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join('\n'),
    [lineCount],
  )
  const activeConn = state.connections.find((item) => item.id === state.activeId)
  const connected = activeConn?.status === 'connected'
  const target = activeConn ? `${activeConn.host}:${activeConn.port}` : t('luaConsole.notConnected')
  const filteredScripts = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return keyword ? scripts.filter((item) => item.name.toLowerCase().includes(keyword)) : scripts
  }, [scripts, query])
  const bulkAllChecked =
    filteredScripts.length > 0 && filteredScripts.every((item) => bulkChecked.has(item.id))
  const bulkSelectedCount = bulkChecked.size

  function resetScroll(): void {
    const area = codeWrapRef.current?.querySelector('textarea')
    if (area) area.scrollTop = 0
    if (gutterRef.current) gutterRef.current.scrollTop = 0
  }

  function clearEditor(): void {
    setSelectedId('')
    setName('')
    setScript('')
    setResult(null)
  }

  function selectScript(item: LuaScript): void {
    setSelectedId(item.id)
    setName(item.name)
    setScript(item.script)
    setResult(null)
    resetScroll()
  }

  function newScript(): void {
    clearEditor()
    setQuery('')
    resetScroll()
  }

  function handleRowClick(item: LuaScript): void {
    if (bulkMode) {
      toggleBulkCheck(item.id)
      return
    }
    selectScript(item)
  }

  function toggleBulkMode(): void {
    setBulkMode((prev) => !prev)
    setBulkChecked(new Set())
  }

  function toggleBulkCheck(id: string): void {
    setBulkChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleBulkAll(): void {
    setBulkChecked(bulkAllChecked ? new Set() : new Set(filteredScripts.map((item) => item.id)))
  }

  async function save(): Promise<void> {
    if (!canSave) return
    const problem = nameProblem(name, scripts, selectedId)
    if (problem) {
      notify('err', t(problem))
      return
    }
    setSaving(true)
    try {
      const res = await api.luaScripts.save({
        id: selectedId || undefined,
        name: name.trim(),
        script,
      })
      if (!res.ok) {
        notify('err', res.error)
        return
      }
      setScripts(res.data)
      // 脚本以文件名为 id，改名后 id 会变，保存后统一跟随服务端返回的选中项
      const saved = res.data[0]
      if (saved) {
        setSelectedId(saved.id)
        setName(saved.name)
        setScript(saved.script)
      }
      setQuery('')
      notify('ok', t('luaConsole.saved'))
    } finally {
      setSaving(false)
    }
  }

  async function removeScript(item: LuaScript): Promise<void> {
    const confirmed = await askConfirm({
      title: t('luaConsole.deleteTitle'),
      message: t('luaConsole.deleteMessage', { name: item.name }),
      confirmText: t('common.delete'),
      compact: true,
      danger: true,
    })
    if (!confirmed) return
    const res = await api.luaScripts.remove(item.id)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    setScripts(res.data)
    setBulkChecked((prev) => {
      if (!prev.has(item.id)) return prev
      const next = new Set(prev)
      next.delete(item.id)
      return next
    })
    if (item.id === selectedId) {
      clearEditor()
      resetScroll()
    }
    notify('ok', t('luaConsole.deleted'))
  }

  async function removeSelected(): Promise<void> {
    const ids = [...bulkChecked]
    if (!ids.length) return
    const confirmed = await askConfirm({
      title: t('luaConsole.batchDeleteTitle', { count: ids.length }),
      message: t('luaConsole.batchDeleteMessage', { count: ids.length }),
      confirmText: t('common.delete'),
      compact: true,
      danger: true,
    })
    if (!confirmed) return
    const res = await api.luaScripts.removeMany(ids)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    setScripts(res.data)
    setBulkChecked(new Set())
    setBulkMode(false)
    if (selectedId && ids.includes(selectedId)) {
      clearEditor()
      resetScroll()
    }
    notify('ok', t('luaConsole.batchDeleted', { count: ids.length }))
  }

  async function run(): Promise<void> {
    if (!state.activeId || !script.trim() || running) return
    setRunning(true)
    setResult(null)
    try {
      const res = await api.redis.evalScript(state.activeId, script, {
        keys: splitLines(keysText),
        args: splitLines(argsText),
        readOnly,
      })
      if (!res.ok) {
        notify('err', res.error)
        return
      }
      setResult(res.data)
      if (!readOnly) void loadKeys(true)
    } finally {
      setRunning(false)
    }
  }

  async function stop(): Promise<void> {
    if (!state.activeId) return
    const res = await api.redis.scriptKill(state.activeId)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? t('luaConsole.stopFailed'))
      return
    }
    notify('ok', t('luaConsole.stopped'))
  }

  async function copyResult(): Promise<void> {
    if (!result) return
    const done = await copyText(result.error ?? result.output)
    if (!done) {
      notify('err', t('common.copyFailedCheckClipboardPermissions'))
      return
    }
    notify('ok', t('luaConsole.resultCopied'))
  }

  async function exportResult(): Promise<void> {
    if (!result) return
    const res = await api.file.saveText({
      suggestedName: `lua-result-${Date.now()}.txt`,
      content: result.error ?? result.output,
    })
    if (!res.ok) notify('err', res.error)
  }

  function handleShortcut(event: React.KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
  }

  const resultState = result ? (result.error ? 'err' : 'ok') : 'idle'

  return (
    <DialogShell
      icon="code"
      title={t('luaConsole.title')}
      description={t('luaConsole.description')}
      badge={<span className="dlg-badge mono">lua</span>}
      className="lua-dialog"
      onClose={onClose}
      footer={
        <>
          <span className="lua-foot-hint">
            <kbd>Ctrl+Enter</kbd>
            <span>{t('luaConsole.run')}</span>
            <span className="sep">·</span>
            <kbd>Ctrl+S</kbd>
            <span>{t('luaConsole.save')}</span>
          </span>
          <span className="spacer" />
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onClose}>
            <DialogIcon name="cancel" size={13} />
            {t('common.close')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="foot-btn foot-quiet"
            disabled={!running}
            onClick={() => void stop()}
          >
            <DialogIcon name="stop" size={13} />
            {t('luaConsole.stop')}
          </Button>
          <Button
            type="button"
            className="foot-btn foot-primary"
            disabled={running || !script.trim() || !state.activeId}
            onClick={() => void run()}
          >
            {running ? (
              <span className="lua-spin" aria-hidden="true" />
            ) : (
              <DialogIcon name="play" size={13} />
            )}
            {running ? t('luaConsole.running') : t('luaConsole.run')}
          </Button>
        </>
      }
    >
      <div className="lua-layout" onKeyDown={handleShortcut}>
        <aside className="lua-side">
          <div className="lua-side-head">
            <span className="lua-side-title">
              {t('luaConsole.scripts')}
              <span className="lua-side-count mono">{scripts.length}</span>
            </span>
            <span className="spacer" />
            {scripts.length >= 2 ? (
              <button
                type="button"
                className={`lua-bulk-toggle${bulkMode ? ' on' : ''}`}
                {...tipProps(t(bulkMode ? 'luaConsole.exitBatchDelete' : 'luaConsole.batchDelete'))}
                onClick={toggleBulkMode}
              >
                <DialogIcon name="trash" size={12} />
              </button>
            ) : null}
            {bulkMode ? null : (
              <button type="button" className="lua-new" onClick={newScript}>
                <DialogIcon name="add" size={11} />
                {t('luaConsole.newScript')}
              </button>
            )}
          </div>

          <FilterBox
            value={query}
            onChange={setQuery}
            placeholder={t('luaConsole.searchScripts')}
            className="lua-search"
          />

          <div className="lua-list">
            {filteredScripts.map((item) => {
              const on = item.id === selectedId
              const checked = bulkChecked.has(item.id)
              return (
                <div
                  key={item.id}
                  className={`lua-item${on && !bulkMode ? ' on' : ''}${checked ? ' checked' : ''}`}
                >
                  <button
                    type="button"
                    className="lua-item-main"
                    onClick={() => handleRowClick(item)}
                  >
                    {bulkMode ? (
                      <span
                        className={`lua-check${checked ? ' on' : ''}`}
                        role="checkbox"
                        aria-checked={checked}
                      >
                        {checked ? <DialogIcon name="check" size={10} /> : null}
                      </span>
                    ) : (
                      <span className="lua-item-glyph">
                        <DialogIcon name="code" size={11} />
                      </span>
                    )}
                    <span className="lua-item-name ellipsis">{item.name}</span>
                    {on && dirty ? <span className="lua-item-dirty" aria-hidden="true" /> : null}
                  </button>
                  {bulkMode ? null : (
                    <button
                      type="button"
                      className="lua-item-del"
                      {...tipProps(t('luaConsole.deleteTitle'))}
                      onClick={() => void removeScript(item)}
                    >
                      <DialogIcon name="trash" size={11} />
                    </button>
                  )}
                </div>
              )
            })}
            {!filteredScripts.length ? (
              <div className="lua-list-empty">
                <DialogIcon name="code" size={16} />
                <span>{loaded ? t('luaConsole.noScripts') : t('common.loading')}</span>
              </div>
            ) : null}
          </div>

          {bulkMode ? (
            <div className="lua-bulk-bar">
              <div className="lua-bulk-head">
                <button
                  type="button"
                  className="lua-bulk-all"
                  {...tipProps(t(bulkAllChecked ? 'luaConsole.deselectAll' : 'luaConsole.selectAll'))}
                  onClick={toggleBulkAll}
                >
                  <span
                    className={`lua-check${bulkAllChecked ? ' on' : ''}`}
                    role="checkbox"
                    aria-checked={bulkAllChecked}
                  >
                    {bulkAllChecked ? <DialogIcon name="check" size={10} /> : null}
                  </span>
                  <span>{t('luaConsole.selectAll')}</span>
                </button>
                <span className="spacer" />
                <span className="lua-bulk-count mono">
                  {t('luaConsole.selectedCount', { count: bulkSelectedCount })}
                </span>
              </div>
              <div className="lua-bulk-actions">
                <button type="button" className="lua-bulk-btn" onClick={toggleBulkMode}>
                  <DialogIcon name="cancel" size={11} />
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="lua-bulk-btn danger"
                  disabled={bulkSelectedCount === 0}
                  onClick={() => void removeSelected()}
                >
                  <DialogIcon name="trash" size={11} />
                  {t('common.delete')}
                </button>
              </div>
            </div>
          ) : (
            <div className="lua-side-foot">
              <span className="lua-target" {...tipProps(target)}>
                <span className={`lua-target-dot${connected ? ' ok' : ''}`} />
                <span className="mono ellipsis">{target}</span>
                {activeConn?.engine === 'redis' ? (
                  <span className="lua-target-db mono">db{activeConn.db}</span>
                ) : null}
              </span>
            </div>
          )}
        </aside>

        <section className="lua-main">
          <div className="lua-toolbar">
            <label className="lua-name-field">
              <DialogIcon name="edit" size={12} />
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('luaConsole.namePlaceholder')}
                maxLength={NAME_MAX}
                spellCheck={false}
                autoComplete="off"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void save()
                  }
                }}
              />
            </label>

            <div className="lua-toolbar-actions">
              <button
                type="button"
                className="lua-tool save"
                disabled={!canSave}
                onClick={() => void save()}
              >
                <DialogIcon name="save" size={12} />
                {saving ? t('luaConsole.saving') : t('luaConsole.save')}
              </button>
            </div>
          </div>

          <div className="lua-editor">
            <div className="lua-editor-head">
              <span className="lua-editor-label">Lua</span>
              <span className="lua-editor-meta mono">
                {t('luaConsole.lineCount', { count: lineCount })}
              </span>
              {dirty ? (
                <span className="lua-dirty">
                  <span className="dot" aria-hidden="true" />
                  {t('luaConsole.unsaved')}
                </span>
              ) : selectedId ? (
                <span className="lua-saved-state">{t('luaConsole.savedState')}</span>
              ) : null}
              <span className="spacer" />
              <span className="lua-editor-hint mono">Ctrl+Enter ↵</span>
            </div>
            <div ref={codeWrapRef} className="lua-code">
              <div ref={gutterRef} className="lua-gutter mono" aria-hidden="true">
                {gutterText}
              </div>
              <Textarea
                value={script}
                onChange={(event) => setScript(event.target.value)}
                className="mono lua-code-input"
                wrap="off"
                spellCheck={false}
                placeholder={t('luaConsole.scriptPlaceholder')}
                onScroll={(event) => {
                  if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Tab') {
                    event.preventDefault()
                    const targetEl = event.currentTarget
                    const start = targetEl.selectionStart
                    const end = targetEl.selectionEnd
                    const next = `${script.slice(0, start)}  ${script.slice(end)}`
                    setScript(next)
                    requestAnimationFrame(() => {
                      targetEl.selectionStart = targetEl.selectionEnd = start + 2
                    })
                  } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault()
                    void run()
                  }
                }}
              />
            </div>
          </div>

          <div className="lua-params">
            <label className="lua-param">
              <span className="lua-param-head">
                <b>KEYS</b>
                <span className="lua-param-count mono">{splitLines(keysText).length}</span>
                <span className="lua-param-hint">{t('luaConsole.onePerLine')}</span>
              </span>
              <Textarea
                value={keysText}
                onChange={(event) => setKeysText(event.target.value)}
                className="mono"
                spellCheck={false}
              />
            </label>
            <label className="lua-param">
              <span className="lua-param-head">
                <b>ARGV</b>
                <span className="lua-param-count mono">{splitLines(argsText).length}</span>
                <span className="lua-param-hint">{t('luaConsole.onePerLine')}</span>
              </span>
              <Textarea
                value={argsText}
                onChange={(event) => setArgsText(event.target.value)}
                className="mono"
                spellCheck={false}
              />
            </label>
          </div>

          <div className="lua-runbar">
            <label className="lua-toggle">
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(event) => setReadOnly(event.target.checked)}
              />
              <span className="lua-toggle-track" aria-hidden="true" />
              <span className="lua-toggle-label">{t('luaConsole.readOnly')}</span>
              <span className="lua-toggle-code mono">{readOnly ? 'EVAL_RO' : 'EVAL'}</span>
            </label>
            <span className="spacer" />
            <span className="lua-run-note">{t('luaConsole.unsavedHint')}</span>
          </div>

          <div className={`lua-result${result?.error ? ' has-error' : ''}`}>
            <div className="lua-result-head">
              <span className={`lua-result-dot ${resultState}`} aria-hidden="true" />
              <span className="lua-result-title">{t('luaConsole.result')}</span>
              {result ? (
                <span className={`lua-chip ${resultState}`}>
                  {result.error ? t('luaConsole.failed') : t('luaConsole.success')}
                </span>
              ) : null}
              {result ? <span className="lua-result-meta mono">{result.costMs}ms</span> : null}
              <span className="spacer" />
              <button
                type="button"
                className="lua-result-btn"
                disabled={!result}
                {...tipProps(t('luaConsole.copyResult'))}
                onClick={() => void copyResult()}
              >
                <DialogIcon name="copy" size={11} />
              </button>
              <button
                type="button"
                className="lua-result-btn"
                disabled={!result}
                {...tipProps(t('luaConsole.exportResult'))}
                onClick={() => void exportResult()}
              >
                <DialogIcon name="export" size={11} />
              </button>
            </div>
            {result ? (
              <pre className={`mono${result.error ? ' lua-error' : ''}`}>
                {result.error ?? result.output}
              </pre>
            ) : running ? (
              <div className="lua-empty">
                <span className="lua-spin" aria-hidden="true" />
                <span>{t('luaConsole.running')}</span>
              </div>
            ) : (
              <div className="lua-empty">
                <DialogIcon name="terminal" size={18} />
                <span>{t('luaConsole.empty')}</span>
                <small>{t('luaConsole.emptyHint')}</small>
              </div>
            )}
          </div>
        </section>
      </div>
    </DialogShell>
  )
}
