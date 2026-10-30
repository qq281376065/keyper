import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@/i18n'
import { prettyJson, utf8Bytes } from '@/utils/format'
import { useRedis } from '@/store/useRedis'
import type { ValueEditorContext } from './shared'

/**
 * 逐行渲染（行号列）的行数上限：超过即回退整块单节点渲染。
 *
 * 阈值 3000 → 300。原值是"9000 DOM 节点"的理论安全线，但实测
 * 274 行（822 节点）就能产生 **1.1 秒**长任务 —— 每行 3 个节点
 * （行 div + 行号 span + 文本 pre）在 JSON 美化后密集重建，
 * 布局与样式计算的开销远高于节点数本身。
 *
 * 100 行的取舍：实测 141 行的 JSON（11KB config）逐行渲染会造出
 * 423 个节点并产生 1.6 秒长任务 —— 单行成本远高于"3 个空节点"，
 * 行号槽的等宽字体 + 每行独立的 pre 块触发了大量样式计算与布局。
 * 低于 100 行的值（常见的一两屏数据）保留行号；更高的走单 pre 整块，
 * 行号让位给流畅度（这类值本来靠搜索定位，不靠肉眼数行）。
 */
const STRING_LINE_LIMIT = 100

/**
 * string 值编辑器：
 * 解析/视图、行内编辑（双击值区域或工具栏「编辑」按钮进入、Esc 取消、
 * Ctrl+Enter 保存）、按行搜索过滤与命中高亮、统计（字符/行/字节/最长行）、
 * 无搜索态逐行视图（行号列，超 STRING_LINE_LIMIT 行回退整块）。
 */
export function useStringEditor(ctx: ValueEditorContext) {
  const { getValue, getKeyword, getPretty } = ctx
  const { saveValue } = useRedis()

  const value = getValue()
  const keyword = getKeyword()
  const pretty = getPretty()

  /**
   * string 值的解析结果只算一次，两处消费（显示文本 / 统计）：
   * raw 是原始值，prettyText 是美化后的文本，jsonOk 标记是否合法 JSON。
   */
  const rawValue = typeof value?.value === 'string' ? value.value : ''
  const parsed = prettyJson(rawValue)
  const stringParsed = { raw: rawValue, prettyText: parsed.ok ? parsed.text : rawValue, jsonOk: parsed.ok }

  /** string：整体美化（不合法 JSON 或关闭美化时原样显示） */
  const stringView = {
    text: pretty && stringParsed.jsonOk ? stringParsed.prettyText : stringParsed.raw,
    jsonOk: stringParsed.jsonOk,
  }

  /**
   * string 行内编辑：双击只读文本（或点工具栏「编辑」按钮）进入编辑态，
   * 操作按钮置于文本框上方。
   * 草稿取「当前看到的内容」—— 开着 JSON 美化时保存的是美化后的文本，
   * 与界面所见一致（所见即所存）。
   *
   * ⚠️ 进入方式是双击而非单击（2026-10 用户反转交互：单击误触太频繁，
   * 查看是高频动作、编辑是低频动作，不该共享同一个手势）。
   */
  const [stringEditing, setStringEditing] = useState(false)
  const [stringDraft, setStringDraft] = useState('')
  const [stringSaving, setStringSaving] = useState(false)
  const stringEditRef = useRef<HTMLTextAreaElement | null>(null)

  function enterStringEdit(): void {
    // 这次点击是拖选文本（复制场景），不要误入编辑态
    if (window.getSelection()?.toString()) return
    setStringDraft(stringView.text)
    setStringEditing(true)
    requestAnimationFrame(() => stringEditRef.current?.focus())
  }

  /**
   * 显式进入编辑：双击值区域 / 工具栏「编辑」按钮共用入口。
   *
   * 先清掉文档选区再走 enterStringEdit 的拖选守卫：
   * - 双击默认会选中击处单词 —— 那是浏览器的默认行为而非"拖选复制"
   *   意图，不清掉会被守卫误拦，双击永远进不了编辑态；
   * - 点工具栏按钮时，值文本上也可能残留此前的拖选，一并清除。
   */
  function enterStringEditExplicit(): void {
    window.getSelection()?.removeAllRanges()
    enterStringEdit()
  }

  function cancelStringEdit(): void {
    setStringEditing(false)
    setStringDraft('')
  }

  async function saveStringEdit(): Promise<void> {
    const v = getValue()
    if (!v || v.type !== 'string' || stringSaving) return
    if (stringDraft === stringView.text) {
      cancelStringEdit()
      return
    }
    setStringSaving(true)
    // 不传 TTL：主进程对 string 走 KEEPTTL，保留键的剩余存活时间
    const ok = await saveValue(v.key, 'string', stringDraft)
    setStringSaving(false)
    if (ok) {
      setStringEditing(false)
      setStringDraft('')
    }
  }

  // 切换到别的键（或当前键被删）时丢弃草稿退出编辑，避免草稿写进下一个键。
  // 用 ref 记住上一次的键：Activity 隐藏后重新显示会重放 effect，
  // 按键值比较而不是无脑清空，否则切回标签时草稿会被误删。
  const currentKey = value?.key ?? ''
  const lastKeyRef = useRef(currentKey)
  useEffect(() => {
    if (lastKeyRef.current === currentKey) return
    lastKeyRef.current = currentKey
    setStringEditing(false)
    setStringDraft('')
  }, [currentKey])

  /*
   * 行拆分只做一次。
   *
   * 原实现把 text.split('\n') 调了三遍（lineCount / statsLines / allRows），
   * 11KB 的值有 274 行，每遍都是新数组 + 274 个字符串；再叠加
   * `new Blob([raw]).size`（每次都分配 Blob）与 274 个 {no,text} 对象，
   * 每次渲染重复分配上千个对象 —— 这正是 2 秒级长任务的来源。
   */
  const text = stringView.text
  const statsLines = useMemo<string[]>(() => (text ? text.split('\n') : []), [text])
  const lineCount = statsLines.length

  /** 最长行统计：行号（1 起）与字符数，-1 表示无内容 */
  const longestLine = useMemo(() => {
    let no = -1
    let len = -1
    statsLines.forEach((line, i) => {
      if (line.length > len) {
        len = line.length
        no = i + 1
      }
    })
    return { no, len }
  }, [statsLines])

  /** string 统计：字符数、行数、字节数、最长行 —— 集中显示在底部状态栏 */
  /*
   * 最长行文案在渲染期翻译（不放进 useMemo）：
   * t() 读取的是当前语言，若缓存进 memo，切换语言后不会随重渲染更新。
   */
  const stringStats = {
    chars: text.length,
    lines: statsLines.length,
    bytes: utf8Bytes(stringParsed.raw),
    longest:
      longestLine.no > 0
        ? t('#{no}（{chars} 字符）', { no: longestLine.no, chars: longestLine.len })
        : '-',
  }

  /**
   * string 搜索视图：按行过滤（保留原始行号，便于回到完整视图中定位）。
   * 行号基于当前显示文本（美化 / 原文），与用户看到的行一致。
   */
  /* 274 行的 {no,text} 数组也只建一次（原实现每次渲染重建）*/
  const allRows = useMemo(
    () => statsLines.map((line, i) => ({ no: i + 1, text: line })),
    [statsLines],
  )
  const stringFilteredLines = useMemo(
    () => (keyword ? allRows.filter((row) => row.text.toLowerCase().includes(keyword)) : allRows),
    [keyword, allRows],
  )

  /**
   * 无搜索态的逐行视图（值文本框内嵌行号列）。
   * 行号从 1 起连续编号，与搜索态 stringFilteredLines 同构 ——
   * 两态共用 .text-line / .line-no / .line-text 样式体系，视觉完全一致。
   */
  const stringLines = allRows

  /**
   * 是否走虚拟滚动。
   *
   * 历史实现：行数超过 100 就回退成整块单节点（**不带行号**）——
   * 因为逐行渲染每行 3 个节点，140 行实测就产生 1.6 秒长任务。
   * 代价是超过阈值的值完全没有行号，用户看到的是"行号消失"，
   * 与本该有的"行号与内容对齐"直接矛盾（getConfigPub 140 行即踩中）。
   *
   * 现在改为虚拟滚动：仍然逐行渲染，但只渲染可视区内的行，
   * DOM 节点数与总行数无关。行号在任何行数下都存在且准确，
   * 长任务也消失了 —— 阈值不再需要，常量保留仅作语义说明。
   */
  const stringLinesVirtual = lineCount > STRING_LINE_LIMIT

  /**
   * 把一行文本按关键词切成片段（命中 / 未命中交替），供渲染高亮。
   *
   * 不用 dangerouslySetInnerHTML：值是用户数据，会引入注入风险；
   * 切片渲染天然转义，安全且性能相当。
   */
  function highlightSegments(line: string): { text: string; hit: boolean }[] {
    const kw = getKeyword()
    if (!kw) return [{ text: line, hit: false }]

    const lower = line.toLowerCase()
    const out: { text: string; hit: boolean }[] = []
    let from = 0
    let idx = lower.indexOf(kw, from)
    while (idx >= 0) {
      if (idx > from) out.push({ text: line.slice(from, idx), hit: false })
      out.push({ text: line.slice(idx, idx + kw.length), hit: true })
      from = idx + kw.length
      idx = lower.indexOf(kw, from)
    }
    if (from < line.length) out.push({ text: line.slice(from), hit: false })
    return out
  }

  return {
    stringParsed,
    stringView,
    stringEditing,
    stringDraft,
    setStringDraft,
    stringSaving,
    stringEditRef,
    enterStringEdit,
    enterStringEditExplicit,
    cancelStringEdit,
    saveStringEdit,
    lineCount,
    stringStats,
    stringFilteredLines,
    stringLines,
    stringLinesVirtual,
    highlightSegments,
  }
}
