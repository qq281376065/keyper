import { useEffect, useRef, useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import { formatHistoryTime, SEARCH_HISTORY_LIMIT, useSearchHistory } from '@/hooks/useSearchHistory'

/**
 * 键名搜索框（带幽灵补全与搜索历史）。
 *
 * 抽出来的原因：Redis 与 Memcached 都需要同一套交互 ——
 * 输入即筛、回车查、Tab 接受幽灵补全、↓ 展开历史、精确匹配开关。
 * 这套交互有近 200 行状态机（IME 组合、键盘路由、滚动对齐），
 * 复制一份到 Memcached 里必然会在后续维护中漂移成两套行为。
 *
 * 与具体引擎无关的部分全部在这里；引擎差异通过 props 表达：
 *   · onSearch    —— 回车/点查询时做什么（Redis 走 SCAN，Memcached 走本地筛）
 *   · exactMode   —— 是否支持精确匹配（Memcached 无服务端全等查询，但仍可本地精确）
 *   · historyDb   —— 历史分桶用的"库号"（Memcached 恒为 0，它没有库）
 */

export interface SearchFilterBoxProps {
  /** 当前输入值 */
  value: string
  onChange: (next: string) => void
  /** 精确匹配状态 */
  exact: boolean
  onToggleExact: () => void
  /** 回车 / 点查询图标：执行一次搜索 */
  onSearch: () => void
  /** 是否禁用（未连接） */
  disabled?: boolean
  /** 历史分桶所需：连接 id 与"库号"（Memcached 传 0） */
  connectionId: string | null
  historyDb: number
  /** 是否显示"精确匹配"开关 */
  showExact?: boolean
  /** 历史浮层标题右侧展示的归属说明（如 "DB 0"） */
  scopeLabel?: string
  placeholder?: string
  /** 订阅会话 store 的钩子（不传则内部不回退订阅，由调用方保证重渲染） */
  onRecord?: () => void
  /** 筛选框右侧的附加内容（如 Redis 同款的「可见 / 总数」纯文字计数） */
  trailing?: React.ReactNode
}

export function SearchFilterBox({
  value,
  onChange,
  exact,
  onToggleExact,
  onSearch,
  disabled = false,
  connectionId,
  historyDb,
  showExact = true,
  scopeLabel,
  placeholder,
  onRecord,
  trailing,
}: SearchFilterBoxProps) {
  const { t } = useI18n()
  const searchHist = useSearchHistory(connectionId, historyDb)
  const [histOpen, setHistOpen] = useState(false)
  const [histSel, setHistSel] = useState(-1)
  const inputEl = useRef<HTMLInputElement | null>(null)
  const ghostLeft = useRef(7)

  /** 当前输入命中的候选（子串、区分大小写 —— 与列表筛选同语义） */
  const histRows = disabled ? [] : searchHist.matches(value)
  /** 下拉展开时隐藏幽灵：列表本身就在展示全部候选 */
  const histGhost = histOpen ? null : searchHist.ghostTarget(value)
  const ghostRest = histGhost ? histGhost.q.slice(value.length) : ''
  const histCount = searchHist.entries.length

  /** 命中片段拆分（before/hit/after 三段，避免 dangerouslySetInnerHTML） */
  const histRowParts = (() => {
    const kw = value.trim()
    return histRows.map((e) => {
      const i = kw ? e.q.indexOf(kw) : -1
      return i < 0
        ? { e, before: e.q, hit: '', after: '' }
        : { e, before: e.q.slice(0, i), hit: e.q.slice(i, i + kw.length), after: e.q.slice(i + kw.length) }
    })
  })()

  /**
   * 幽灵文字的横向位置：与输入框同字体量宽。
   * 必须减 scrollLeft —— 长文本滚到中间时，幽灵要跟着走，
   * 否则会浮在错误的字符位置上。
   */
  const textMeasure = useRef<CanvasRenderingContext2D | null>(null)
  function layoutGhost(): void {
    const el = inputEl.current
    if (!el || !ghostRest) return
    if (!textMeasure.current) {
      textMeasure.current = document.createElement('canvas').getContext('2d')
      if (!textMeasure.current) return
      const cs = getComputedStyle(el)
      textMeasure.current.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    }
    /* 7 = .filter-box 的 padding-left */
    ghostLeft.current = Math.max(0, 7 + textMeasure.current.measureText(value).width - el.scrollLeft)
  }

  useEffect(() => {
    setHistSel(-1)
    requestAnimationFrame(layoutGhost)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  /* 连接/库切换：历史按桶重载，浮层立即收起防串数据 */
  useEffect(() => {
    setHistOpen(false)
    setHistSel(-1)
  }, [connectionId, historyDb])

  function acceptGhost(): boolean {
    const t = searchHist.ghostTarget(value)
    if (!t) return false
    onChange(t.q)
    return true
  }

  function closeHist(): void {
    setHistOpen(false)
    setHistSel(-1)
  }

  function runSearch(): void {
    if (disabled) return
    onSearch()
    onRecord?.()
    if (value.trim()) void searchHist.record(value)
    closeHist()
  }

  /** 从历史填入（只填不搜：长键名需要用户确认后再执行） */
  function fillFromHistory(q: string): void {
    onChange(q)
    closeHist()
    requestAnimationFrame(() => {
      const el = inputEl.current
      if (!el) return
      el.focus()
      el.setSelectionRange(q.length, q.length)
    })
  }

  function toggleHist(): void {
    if (histOpen) closeHist()
    else if (histRows.length) {
      setHistOpen(true)
      setHistSel(0)
    }
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    /* IME 组合期间的按键不参与路由（拼音确认会误触发） */
    if (e.nativeEvent.isComposing) return
    const key = e.key

    if (key === 'Tab' || (key === 'ArrowRight' && ghostRest)) {
      const atEnd = !inputEl.current || inputEl.current.selectionStart === value.length
      if ((key === 'Tab' || atEnd) && acceptGhost()) e.preventDefault()
      return
    }

    if (key === 'ArrowDown') {
      if (!histOpen) {
        if (!histRows.length) return /* 无候选不展开，保留光标默认行为 */
        e.preventDefault()
        setHistOpen(true)
        setHistSel(0)
      } else {
        e.preventDefault()
        setHistSel((prev) => Math.min(prev + 1, histRows.length - 1))
      }
      return
    }

    if (key === 'ArrowUp' && histOpen) {
      e.preventDefault()
      setHistSel((prev) => Math.max(prev - 1, 0))
      return
    }

    if (key === 'Escape' && histOpen) {
      e.preventDefault()
      closeHist()
      return
    }

    if (key === 'Enter') {
      e.preventDefault()
      if (histOpen && histSel >= 0 && histRows[histSel]) {
        fillFromHistory(histRows[histSel]!.q)
        return
      }
      runSearch()
    }
  }

  const placeholderText =
    placeholder ?? (exact ? t('searchFilterBox.enterFullKeyNamePress') : t('searchFilterBox.typingFiltersListPressEnter'))

  return (
    <div className="filter-row">
      <label className={`filter-box${disabled ? ' disabled' : ''}`}>
        <input
          ref={inputEl}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="filter"
          placeholder={placeholderText}
          disabled={disabled}
          onKeyDown={onKeyDown}
          onBlur={() => {
            /* 延时收起：给浮层上的 mousedown 点击留出落地时间 */
            setTimeout(closeHist, 130)
          }}
        />
        {ghostRest ? (
          <span className="f-ghost" style={{ left: `${ghostLeft.current}px` }} aria-hidden="true">
            {ghostRest}
          </span>
        ) : null}

        {value ? (
          <button
            className="f-clear"
            {...tipProps(t('memcachedOverview.clear'))}
            onClick={() => {
              onChange('')
              inputEl.current?.focus()
            }}
          >
            <DialogIcon name="cancel" size={12} />
          </button>
        ) : null}

        {!disabled && value && histRows.length ? (
          <button
            className={`f-caret${histOpen ? ' on' : ''}`}
            role="button"
            aria-expanded={histOpen}
            {...tipProps(t('keyBrowser.historySuggestions'))}
            onMouseDown={(event) => {
              event.preventDefault()
              toggleHist()
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
        ) : null}

        <button
          className="f-search"
          disabled={disabled || !value.trim()}
          {...tipProps(t('keyBrowser.query'))}
          onClick={runSearch}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
        </button>

        {showExact ? (
          <button
            className={`f-exact${exact ? ' on' : ''}`}
            role="checkbox"
            aria-checked={exact}
            disabled={disabled}
            {...tipProps(t('keyBrowser.exactMatch'))}
            onClick={onToggleExact}
          >
            <span className="ex-box">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
            </span>
          </button>
        ) : null}

        {histOpen ? (
          <div className="hist-pop">
            <div className="hp-head">
              <span>{t('keyBrowser.currentConnectionOnly')}</span>
              {scopeLabel ? <span className="hp-db">· {scopeLabel}</span> : null}
              <span className={`hp-count${histCount >= SEARCH_HISTORY_LIMIT ? ' full' : ''}`}>
                {histCount}/{SEARCH_HISTORY_LIMIT}
              </span>
            </div>
            <div className="hp-body">
              {!histRowParts.length ? (
                <div className="hp-empty">
                  {value.trim() ? t('keyBrowser.noMatchingHistory') : t('keyBrowser.noSearchHistoryForConnection')}
                  <br />
                  {t('keyBrowser.runQuery')}
                </div>
              ) : null}
              {histRowParts.map((row, i) => (
                <div
                  key={row.e.q}
                  className={`hp-row${i === histSel ? ' sel' : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    fillFromHistory(row.e.q)
                  }}
                >
                  <span className="hp-q mono">
                    {row.before ? <span>{row.before}</span> : null}
                    {row.hit ? <mark>{row.hit}</mark> : null}
                    {row.after ? <span>{row.after}</span> : null}
                  </span>
                  <span className="hp-meta mono">
                    {row.e.count > 1 ? <span className="hp-times">×{row.e.count}</span> : null}
                    <span className="hp-time">{formatHistoryTime(row.e.at)}</span>
                    <button
                      className="hp-del"
                      {...tipProps(t('searchFilterBox.removeHistory'))}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        void searchHist.remove(row.e.q)
                      }}
                    >
                      <DialogIcon name="cancel" size={10} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
            {histCount ? (
              <div className="hp-foot">
                <button
                  className="hp-clear"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    void searchHist.clear()
                  }}
                >
                  {t('searchFilterBox.clearHistory')}
                </button>
                <span className="hp-tip">{t('searchFilterBox.tabCompleteSelectEnterSearch')}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </label>
      {trailing}
    </div>
  )
}

export default SearchFilterBox
