/**
 * JSON 树形视图的节点模型（纯计算，零 DOM / 零副作用，便于单测）。
 *
 * 行结构参考 firefox-toolkit-addon 的 JSON 查看器中栏树：
 *   · 结构节点标题 `key  {Object:n}` / `key  [Array:n]`（计数是结构信息，常显）
 *   · 叶子标题 `key: value`（字符串带引号，控制字符替换为空格）
 *   · 超长字符串截断为前缀 + 省略号，完整值留在 fullText 供「查看」弹窗
 *   · path 为从根到当前节点的定位串（对象 `.key`、数组 `[i]`），展开态按 path 记录
 */

/** 节点类型：决定图标形状与语义色 */
export type JsonNodeKind = 'object' | 'array' | 'string' | 'int' | 'float' | 'bool' | 'null'

export interface JsonTreeNode {
  /** 显示名：对象键名 / 数组 [i] / 根为 $ */
  key: string
  /** 根到当前的定位串（展开态 / React key 的唯一标识） */
  path: string
  kind: JsonNodeKind
  /** 结构节点的子节点；叶子为 null */
  children: JsonTreeNode[] | null
  /** 结构节点标题（含计数后缀）；叶子为 null */
  structLabel: string | null
  /** 叶子显示值（已截断、字符串已带引号）；结构节点为 null */
  leafText: string | null
  /** 长值被截断时的完整显示值（含引号）；未截断为 null */
  fullText: string | null
  depth: number
}

export interface JsonTreeStats {
  /** 节点总数（含未展开的） */
  nodes: number
  /** 最大深度（根为 0） */
  maxDepth: number
}

/** 长值截断阈值 / 保留前缀（与参考项目同一量级） */
export const TREE_FOLD_THRESHOLD = 120
export const TREE_FOLD_PREFIX = 80

/** 控制字符（含 \u007f）替换为空格，避免树行被不可见字符打乱 */
function sanitize(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ')
}

function kindOf(value: unknown): JsonNodeKind {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float'
  return 'string'
}

function formatLeaf(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return `"${sanitize(value)}"`
  return String(value)
}

function buildNode(value: unknown, key: string, path: string, depth: number): JsonTreeNode {
  const kind = kindOf(value)
  if (kind === 'array') {
    const arr = value as unknown[]
    return {
      key,
      path,
      kind,
      children: arr.map((item, i) => buildNode(item, `[${i}]`, `${path}[${i}]`, depth + 1)),
      structLabel: `${key}  [Array:${arr.length}]`,
      leafText: null,
      fullText: null,
      depth,
    }
  }
  if (kind === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    return {
      key,
      path,
      kind,
      children: keys.map((k) => buildNode(obj[k], k, `${path}.${k}`, depth + 1)),
      structLabel: `${key}  {Object:${keys.length}}`,
      leafText: null,
      fullText: null,
      depth,
    }
  }
  const text = formatLeaf(value)
  const isLong = typeof value === 'string' && sanitize(value).length > TREE_FOLD_THRESHOLD
  return {
    key,
    path,
    kind,
    children: null,
    structLabel: null,
    leafText: isLong ? `"${sanitize(value as string).slice(0, TREE_FOLD_PREFIX)}…"` : text,
    fullText: isLong ? text : null,
    depth,
  }
}

export type JsonTreeResult =
  | { ok: true; root: JsonTreeNode; stats: JsonTreeStats }
  | { ok: false; error: 'not-json' | 'not-structured' }

/**
 * 把 JSON 文本转成树模型。
 * 仅接受对象 / 数组根（标量 JSON 如 `42` / `"str"` 没有树形意义，拒绝）。
 */
export function buildJsonTree(text: string): JsonTreeResult {
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return { ok: false, error: 'not-json' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: 'not-json' }
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, error: 'not-structured' }
  const root = buildNode(parsed, '$', '$', 0)
  let nodes = 0
  let maxDepth = 0
  const walk = (node: JsonTreeNode): void => {
    nodes += 1
    if (node.depth > maxDepth) maxDepth = node.depth
    if (node.children) for (const child of node.children) walk(child)
  }
  walk(root)
  return { ok: true, root, stats: { nodes, maxDepth } }
}

/** 收集全部结构节点路径（「全部展开」用） */
export function collectStructPaths(root: JsonTreeNode, out: string[] = []): string[] {
  if (root.children) {
    out.push(root.path)
    for (const child of root.children) collectStructPaths(child, out)
  }
  return out
}