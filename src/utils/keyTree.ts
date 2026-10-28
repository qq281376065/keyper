import type { RedisKeyItem } from '@shared/types'

/** 键树节点：中间节点只承载路径，叶子节点对应真实存在的键 */
export interface KeyTreeNode {
  /** 当前层级显示名（如 a、aa、1） */
  label: string
  /** 从根到当前的完整路径，作为折叠状态的唯一标识 */
  path: string
  /** 该节点自身是否是真实存在的键 */
  leaf?: RedisKeyItem
  children: KeyTreeNode[]
  /** 子树内包含的真实键数量，用于折叠态显示计数 */
  leafCount: number
}

/**
 * 按键名分隔符构建树。
 *
 * 示例（separator = ":"）：
 *   a:aa:1 / a:aa:2 / a:bb  →  a ─┬─ aa ─┬─ 1
 *                                  │      └─ 2
 *                                  └─ bb
 *
 * 注意：`a:aa` 既是前缀也可能本身是一个键，因此节点可同时持有 leaf 与 children。
 * 对于含空段的键（如 `a::1`、`x:`），路径还原会产生歧义，统一退化为根级节点处理。
 */
export function buildKeyTree(keys: RedisKeyItem[], separator = ':'): KeyTreeNode[] {
  const root: KeyTreeNode = { label: '', path: '', children: [], leafCount: 0 }
  const index = new Map<string, KeyTreeNode>([['', root]])

  for (const item of keys) {
    const parts = separator ? item.key.split(separator) : [item.key]

    if (parts.some((part) => part === '')) {
      // 含连续/首尾分隔符，直接挂在根上，避免与其他路径混淆
      const existing = index.get(item.key)
      if (existing) {
        existing.leaf = item
      } else {
        const node: KeyTreeNode = { label: item.key, path: item.key, leaf: item, children: [], leafCount: 1 }
        index.set(item.key, node)
        root.children.push(node)
      }
      continue
    }

    let parentPath = ''
    parts.forEach((part, position) => {
      const path = parentPath ? `${parentPath}${separator}${part}` : part
      let node = index.get(path)
      if (!node) {
        node = { label: part, path, children: [], leafCount: 0 }
        index.set(path, node)
        index.get(parentPath)!.children.push(node)
      }
      if (position === parts.length - 1) node.leaf = item
      parentPath = path
    })
  }

  countLeaves(root)
  sortTree(root)
  return root.children
}

function countLeaves(node: KeyTreeNode): number {
  let total = node.leaf ? 1 : 0
  for (const child of node.children) total += countLeaves(child)
  node.leafCount = total
  return total
}

function sortTree(node: KeyTreeNode): void {
  node.children.sort((a, b) => {
    // 含子级的目录节点排在前，同组内按自然序（支持 a2 < a10）
    const groupA = a.children.length > 0 ? 0 : 1
    const groupB = b.children.length > 0 ? 0 : 1
    if (groupA !== groupB) return groupA - groupB
    return a.label.localeCompare(b.label, 'zh-CN', { numeric: true })
  })
  for (const child of node.children) sortTree(child)
}

/** 收集树上的全部目录节点路径，用于「全部展开 / 全部折叠」 */
export function collectParents(nodes: KeyTreeNode[], result: string[] = []): string[] {
  for (const node of nodes) {
    if (node.children.length) {
      result.push(node.path)
      collectParents(node.children, result)
    }
  }
  return result
}
/**
 * 收集深度 ≥ depth 的目录节点路径，用于「展开至第 N 层」。
 * 顶层目录深度为 1（与 buildKeyTree 按分隔符逐段建层的口径一致）。
 * 例如 collectParentsBelow(nodes, 2) 返回第 2 层及以下的全部目录 ——
 * 把它们放进折叠集，即得到「第 1 层展开、更深层折叠」的 L1 视图。
 */
export function collectParentsBelow(
  nodes: KeyTreeNode[],
  depth: number,
  result: string[] = [],
  currentDepth = 1,
): string[] {
  for (const node of nodes) {
    if (node.children.length) {
      if (currentDepth >= depth) result.push(node.path)
      collectParentsBelow(node.children, depth, result, currentDepth + 1)
    }
  }
  return result
}
