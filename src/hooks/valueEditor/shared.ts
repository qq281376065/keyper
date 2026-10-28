import type { KeyValue } from '@shared/types'
import type { ServerCapabilities } from '@/utils/redisCapability'

/**
 * 值区六类型编辑器的公共依赖。
 *
 * 移植说明：Vue 版 ctx 里是 Ref / ComputedRef，读写都要 .value；
 * React 版改成一个「getter 对象」——调用方（ValueViewer 的 hook 组装处）
 * 用闭包捕获当前渲染的 state，读到的是最新值，写法上只需去掉 .value。
 */
export interface ValueEditorContext {
  getValue: () => KeyValue | null
  getKeyword: () => string
  getPretty: () => boolean
  getCapabilities: () => ServerCapabilities
  getSortKey: () => 'field' | 'value' | 'member' | null
  getSortAsc: () => boolean
}

/** 按首个 "::" 切分；用 indexOf 而非 split，避免值本身含 "::" 时被截断 */
export function splitPair(raw: string): [string, string] {
  const index = raw.indexOf('::')
  if (index < 0) return [raw.trim(), '']
  return [raw.slice(0, index).trim(), raw.slice(index + 2).trim()]
}

/**
 * 比较两个 stream entry ID（形如 `1760668800123-0`）。
 *
 * 不能直接字符串比较：`...-10` 在字典序里会小于 `...-9`，
 * 而 Redis 的序号是按数值递增的。因此拆成「毫秒时间戳」与「序号」两段分别按数值比。
 */
export function compareEntryId(a: string, b: string): number {
  const [aMs, aSeq] = a.split('-')
  const [bMs, bSeq] = b.split('-')
  const diff = Number(aMs) - Number(bMs)
  if (diff !== 0) return diff
  return Number(aSeq ?? 0) - Number(bSeq ?? 0)
}

/** lineView 的单行：left 与 text 的含义随类型而定（成员/entry ID 在左，值/score/字段在右） */
export interface LineViewRow {
  /** 原始数组中的真实下标，排序/搜索不变，修改/删除/插入一律依据它 */
  index: number
  left: string
  text: string
  /** zset 的 score 数值化（其他类型恒 0），排序必须按数值比大小 */
  score: number
  /** 展示序号：按当前展示顺序从 1 起编号，仅作视觉参考 */
  position: number
}

export interface LineView {
  rows: LineViewRow[]
  total: number
}

/**
 * list / set / zset / stream：统一按行渲染，左右分列由类型决定。
 *
 * index 始终是数据在原始数组中的真实下标 —— 排序、搜索都不改变它，
 * 后续的修改 / 删除 / 插入都必须依赖它，否则会操作到错误的元素。
 * 显示给用户的序号另用 position（排序后重编），仅作视觉参考。
 */
export function buildLineView(
  value: KeyValue | null,
  keyword: string,
  sortKey: 'field' | 'value' | 'member' | null,
  sortAsc: boolean,
): LineView {
  const items = Array.isArray(value?.value) ? (value!.value as string[]) : []
  const type = value?.type
  const total = items.length

  const rows = items
    .map((raw, index) => ({ raw, index }))
    .filter(({ raw }) => !keyword || raw.toLowerCase().includes(keyword))
    .map(({ raw, index }) => {
      if (type === 'zset') {
        const [member, score] = splitPair(raw)
        // score 转数值：排序必须按数值比大小，字符串比较会把 100 排在 99 前面
        return { index, left: member, text: score, score: Number(score) }
      }
      if (type === 'stream') {
        const [entryId, fields] = splitPair(raw)
        // 字段原样展示，不做 JSON 美化 —— stream 的字段是扁平的 key=value 列表，
        // 缩进重排反而拉开行高、降低一屏内的信息密度
        return { index, left: entryId, text: fields, score: 0 }
      }
      return { index, left: '', text: raw, score: 0 }
    })

  /*
   * 排序：
   * - zset 支持按 score 与 member 排序 —— 它本就有序，排序是其核心语义。
   *   未指定（默认）时按 score 降序，对应 ZREVRANGE 的排行榜视角；
   *   点 member 表头即按成员名排序，可再点切换升降序。
   * - list 由用户点 value 表头触发；
   * - stream 可按 entry ID 排序（ID 由毫秒时间戳构成，即消息时序）；
   * - set 无序，不提供排序。
   * 排序不改变 index，后续操作仍按真实下标执行。
   */
  if (type === 'zset') {
    if (sortKey === 'member') {
      rows.sort(
        (a, b) => a.left.localeCompare(b.left, 'zh-CN', { numeric: true }) * (sortAsc ? 1 : -1),
      )
    } else {
      // score 列：显式点击则按其方向，否则默认降序（排行榜视角）
      const dir = sortKey === 'value' ? (sortAsc ? 1 : -1) : -1
      rows.sort((a, b) => (a.score - b.score) * dir)
    }
  } else if (type === 'list' && sortKey === 'value') {
    rows.sort(
      (a, b) => a.text.localeCompare(b.text, 'zh-CN', { numeric: true }) * (sortAsc ? 1 : -1),
    )
  } else if (type === 'stream' && sortKey === 'member') {
    // entry ID 形如 1760668800123-0；按数值比较才能正确处理 -<seq> 序号
    rows.sort((a, b) => compareEntryId(a.left, b.left) * (sortAsc ? 1 : -1))
  }

  // 显示序号：按当前展示顺序从 1 起编号（set 下仅作行计数，不代表存储顺序）
  return { rows: rows.map((row, position) => ({ ...row, position: position + 1 })), total }
}
