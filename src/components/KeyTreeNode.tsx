import { useEffect, useRef } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { LiveTtl } from '@/components/LiveTtl'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import type { KeyTreeNode as KeyTreeNodeModel } from '@/utils/keyTree'
import { ttlAtOf } from '@/utils/format'
import { typeAbbr, typeLabel } from '@/utils/typeLabel'

export interface KeyTreeNodeProps {
  node: KeyTreeNodeModel
  depth: number
  separator: string
  selectedKey: string | null
  collapsed: Set<string>
  /** 勾选模式：开启后每行前面出现复选框 */
  selecting?: boolean
  /** 勾选态判定：声明式传值无法表达"目录全选/部分选中"，故传判定函数 */
  isPicked?: (node: KeyTreeNodeModel) => boolean
  isIndeterminate?: (node: KeyTreeNodeModel) => boolean
  onToggle: (path: string) => void
  onSelect: (key: string) => void
  onRemove: (key: string) => void
  onPick: (node: KeyTreeNodeModel) => void
  onContext: (payload: { node: KeyTreeNodeModel; depth: number; event: React.MouseEvent }) => void
  /** 判断键是否已收藏：传函数而不是集合，递归子节点复用同一份 */
  isFavorite?: (key: string) => boolean
  /** 点击收藏图标：收藏 / 取消收藏 */
  onToggleFavorite?: (key: string) => void
}

/**
 * 树形模式下的单个节点（递归组件）。
 *
 * 右键触发范围（两类，互斥）：
 * 1. **子树**：任何**有子节点**的目录节点 —— 不限层级，代表一段前缀；
 * 2. **原子节点**：对应真实存在的键（`node.leaf` 存在）—— 单键菜单。
 *
 * 判定看「有无子节点」而非深度：无分隔符的键（如 healthcheck）在
 * 树里同样是 depth 0，但它是原子节点而非前缀。
 */
export function KeyTreeNode({
  node,
  depth,
  selectedKey,
  collapsed,
  selecting,
  isPicked,
  isIndeterminate,
  onToggle,
  onSelect,
  onRemove,
  onPick,
  onContext,
  isFavorite,
  onToggleFavorite,
}: KeyTreeNodeProps) {
  const { t } = useI18n()
  const checkboxRef = useRef<HTMLInputElement | null>(null)

  const hasChildren = node.children.length > 0
  const isCollapsed = collapsed.has(node.path)
  const isActive = !!node.leaf && node.leaf.key === selectedKey
  const favorited = !!node.leaf && !!isFavorite?.(node.leaf.key)
  const picked = selecting ? !!isPicked?.(node) : false
  const indeterminate = selecting ? !!isIndeterminate?.(node) : false

  /* indeterminate 不是 HTML 属性而是 DOM 属性，React 无法经 JSX 传入，需渲染后显式赋值 */
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = indeterminate
  }, [indeterminate, picked, selecting])

  function handleContextMenu(event: React.MouseEvent): void {
    const isSubtree = node.children.length > 0
    const isAtomicKey = !!node.leaf
    if (!isSubtree && !isAtomicKey) return
    event.preventDefault()
    onContext({ node, depth, event })
  }

  function handleRowClick(): void {
    /*
     * 勾选模式下点击行 = 切换勾选，不再展开/收起、也不加载值。
     * 此时用户的注意力在"圈选范围"上：点一下就展开目录会让树不停跳动。
     */
    if (selecting) {
      onPick(node)
      return
    }
    if (node.leaf) {
      onSelect(node.leaf.key)
      return
    }
    if (hasChildren) onToggle(node.path)
  }

  function handleCaret(event: React.MouseEvent): void {
    event.stopPropagation()
    onToggle(node.path)
  }

    return (
    <div className="tree-node s-key-tree-node">
      <div
        className={`node-row${isActive ? ' active' : ''}${hasChildren && !node.leaf ? ' folder' : ''}${
          selecting && picked ? ' picked' : ''
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={handleRowClick}
        onContextMenu={handleContextMenu}
      >
        {hasChildren ? (
          <button className="caret" onClick={handleCaret}>
            <svg viewBox="0 0 12 12" className={`caret-ico${isCollapsed ? ' collapsed' : ''}`} aria-hidden="true">
              <path d="M4.2 2.6 8.4 6l-4.2 3.4z" />
            </svg>
          </button>
        ) : (
          <span className="caret placeholder" />
        )}

        {/* 勾选模式：复选框取代文件夹/类型徽标的位置 */}
        {selecting ? (
          <label className="pick-box" onClick={(event) => event.stopPropagation()}>
            <input ref={checkboxRef} type="checkbox" checked={picked} onChange={() => onPick(node)} />
          </label>
        ) : null}

        {/*
          文件夹图标：收起态为闭合形状，展开态为「上半盖 + 下半开口盒」。
          SVG 内部的分组必须用 <g>，Fragment 在 SVG 命名空间下不生效。
        */}
        {hasChildren ? (
          <svg viewBox="0 0 16 16" className={`folder-icon${isCollapsed ? ' collapsed' : ''}`} aria-hidden="true">
            {isCollapsed ? (
              <path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h2.6l1.3 1.5h5.7A1.2 1.2 0 0 1 14 5.7v5.1A1.2 1.2 0 0 1 12.8 12H3.2A1.2 1.2 0 0 1 2 10.8z" />
            ) : (
              <g>
                <path d="M2 4.4A1.2 1.2 0 0 1 3.2 3.2h2.5l1.3 1.5h5.6c.66 0 1.2.54 1.2 1.2v.6H2z" />
                <path d="M2.3 7.2h11.4l-.9 3.9a1.2 1.2 0 0 1-1.17.94H3.4a1.2 1.2 0 0 1-1.17-.94z" />
              </g>
            )}
          </svg>
        ) : null}

        {/* 单字符圆形徽标：全称走 tooltip，避免在 450px 键栏里吃掉键名空间 */}
        {node.leaf ? (
          <span className={`type-badge type-${node.leaf.type}`} {...tipProps(typeLabel(node.leaf.type))}>
            {typeAbbr(node.leaf.type)}
          </span>
        ) : null}

        <span className="label mono ellipsis" {...tipProps(node.path)}>
          {node.label}
        </span>

        {hasChildren ? <span className="count mono">{node.leafCount}</span> : null}

        {node.leaf ? (
          <LiveTtl className="ttl mono" ttl={node.leaf.ttl} ttlAt={ttlAtOf(node.leaf)} />
        ) : null}

        {node.leaf ? (
          <button
            className={`key-fav${favorited ? ' on' : ''}`}
            {...tipProps(favorited ? t('favorites.remove') : t('favorites.add'))}
            onClick={(event) => {
              event.stopPropagation()
              onToggleFavorite?.(node.leaf!.key)
            }}
          >
            <DialogIcon name="star" size={11} />
          </button>
        ) : null}

        {node.leaf ? (
          <button
            className="del-btn"
            {...tipProps(t('common.deleteThisKey'))}
            onClick={(event) => {
              event.stopPropagation()
              onRemove(node.leaf!.key)
            }}
          >
            <DialogIcon name="cancel" size={10} />
          </button>
        ) : null}
      </div>

      {hasChildren && !isCollapsed
        ? node.children.map((child) => (
            <KeyTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              separator={''}
              selectedKey={selectedKey}
              collapsed={collapsed}
              selecting={selecting}
              isPicked={isPicked}
              isIndeterminate={isIndeterminate}
              onToggle={onToggle}
              onSelect={onSelect}
              onRemove={onRemove}
              onPick={onPick}
              onContext={onContext}
              isFavorite={isFavorite}
              onToggleFavorite={onToggleFavorite}
            />
          ))
        : null}
    </div>
  )
}

export default KeyTreeNode
