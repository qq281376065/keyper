import { useMemo, useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { TreeValueDialog } from '@/components/TreeValueDialog'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import {
  collectStructPaths,
  type JsonTreeNode,
  type JsonTreeStats,
} from '@/utils/jsonTree'

/**
 * JSON 树形视图（string 值格式菜单的「树形结构」）。
 *
 * 行结构参考 firefox-toolkit-addon JSON 查看器中栏树：
 *   缩进竖线 × depth（祖先层是否延续）+ 本层 ├/└ 连线 + ± 折叠方块 +
 *   类型图标（object 蓝括号 / array 紫括号 / 标量语义色点）+ 标题。
 *
 * 与参考项目的差异（按本项目交互惯例取舍）：
 *   · 默认展开根与第一层（参考项目全折叠）——点开即见结构，少一次点击；
 *   · 子节点懒渲染：折叠的子树不进 DOM，超大 JSON 只付已展开部分的成本；
 *   · 长值截断 + 「查看」弹窗（完整值可复制），不做搜索/跳转（值区已有搜索框）。
 */

interface RowProps {
  node: JsonTreeNode
  /** 祖先层竖线延续标记：flags[d]=1 表示第 d 层祖先非末位、竖线要贯穿本行 */
  flags: number[]
  isLast: boolean
  expanded: ReadonlySet<string>
  onToggle: (path: string) => void
  onView: (node: JsonTreeNode) => void
}

function TreeRow({ node, flags, isLast, expanded, onToggle, onView }: RowProps) {
  const { t } = useI18n()
  const isStruct = node.children != null
  const isOpen = isStruct && expanded.has(node.path)

  return (
    <li className="jt-li">
      <div className="jt-row">
        {/* 祖先层缩进：flags[d]=1 画贯穿竖线，0 留空 */}
        {flags.map((line, d) => (
          <span key={d} className={`jt-indent${line ? ' jt-line' : ''}`} />
        ))}
        {/* 本层连线：├（非末位）/ └（末位）；根节点不画 */}
        {node.depth > 0 ? (
          <span className={`jt-indent ${isLast ? 'jt-joinbottom' : 'jt-join'}`} />
        ) : null}
        {/* ± 折叠方块：结构节点才有；叶子用空占位保持列对齐 */}
        {isStruct ? (
          <button
            type="button"
            className={`jt-hit ${isOpen ? 'jt-expanded' : 'jt-collapsed'}`}
            aria-label={isOpen ? t('valueFormats.treeCollapse') : t('valueFormats.treeExpand')}
            onClick={() => onToggle(node.path)}
          />
        ) : (
          <span className="jt-indent" />
        )}
        <span className={`jt-icon jt-ico-${node.kind}`} />
        {isStruct ? (
          <span className="jt-title jt-struct mono" onClick={() => onToggle(node.path)}>
            {node.structLabel}
          </span>
        ) : (
          <span className="jt-title mono">
            <span className="jt-tk">{node.key}</span>
            <span className="jt-colon">: </span>
            <span
              className={`jt-tv jt-val-${node.kind}`}
              {...(node.fullText ? tipProps(node.fullText.slice(0, 2000)) : {})}
            >
              {node.leafText}
            </span>
            {node.fullText ? (
              <button type="button" className="jt-view-btn" onClick={() => onView(node)}>
                {t('valueFormats.treeView')}
              </button>
            ) : null}
          </span>
        )}
      </div>
      {/* 懒渲染：展开时才把子树挂进 DOM */}
      {isStruct && isOpen ? (
        <ul className="jt-ul">
          {node.children!.map((child, i) => (
            <TreeRow
              key={child.path}
              node={child}
              flags={[...flags, isLast ? 0 : 1]}
              isLast={i === node.children!.length - 1}
              expanded={expanded}
              onToggle={onToggle}
              onView={onView}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export interface JsonTreeViewProps {
  root: JsonTreeNode
  stats: JsonTreeStats
}

export function JsonTreeView({ root, stats }: JsonTreeViewProps) {
  const { t } = useI18n()
  /* 默认展开根 + 第一层结构节点：点开即见整体形状 */
  const initialExpanded = useMemo(() => {
    const set = new Set<string>([root.path])
    if (root.children) {
      for (const child of root.children) {
        if (child.children) set.add(child.path)
      }
    }
    return set
  }, [root])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(initialExpanded)
  const [viewing, setViewing] = useState<JsonTreeNode | null>(null)

  /* root 变化（换键/重选格式）时重置展开态 */
  const [lastRoot, setLastRoot] = useState(root)
  if (root !== lastRoot) {
    setLastRoot(root)
    setExpanded(initialExpanded)
  }

  function toggle(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function expandAll(): void {
    setExpanded(new Set(collectStructPaths(root)))
  }

  function collapseAll(): void {
    setExpanded(new Set([root.path]))
  }

  return (
    <div className="jt-wrap s-json-tree-view">
      <div className="jt-toolbar">
        <span className="jt-stat mono">
          {t('valueFormats.treeStat', { nodes: stats.nodes, depth: stats.maxDepth })}
        </span>
        <span className="spacer" />
        {/* 图标组合胶囊：与值区工具条 seg-group 同形态（凹槽+连续段），高度更紧凑 */}
        <div className="jt-seg">
          <button type="button" className="jt-seg-btn" onClick={expandAll} {...tipProps(t('valueFormats.treeExpandAll'))}>
            <DialogIcon name="expand" size={12} />
          </button>
          <button type="button" className="jt-seg-btn" onClick={collapseAll} {...tipProps(t('valueFormats.treeCollapseAll'))}>
            <DialogIcon name="collapse" size={12} />
          </button>
        </div>
      </div>
      <div className="jt-body">
        <ul className="jt-ul jt-root">
          <TreeRow
            node={root}
            flags={[]}
            isLast
            expanded={expanded}
            onToggle={toggle}
            onView={setViewing}
          />
        </ul>
      </div>
      {viewing ? <TreeValueDialog node={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  )
}

export default JsonTreeView