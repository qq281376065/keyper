import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import { formatTtl, ttlTone } from '@/utils/format'
import type { KeyTreeNode } from '@/utils/keyTree'

/**
 * Memcached 键栏树形行（从 MemcachedKeyBrowser 拆出，JSX 与行为原样保留）。
 * 行结构与 Redis 版 KeyTreeNode 一致；Memcached 没有类型，徽标统一 M。
 */

type McTreeNode = KeyTreeNode

export function collectLeaves(node: McTreeNode): string[] {
  const out: string[] = []
  if (node.leaf) out.push(node.leaf.key)
  for (const child of node.children) out.push(...collectLeaves(child))
  return out
}

/** 递归统计子树里的键数（目录显示用） */
function countLeaves(node: McTreeNode): number {
  return node.leafCount
}

interface McTreeRowProps {
  node: McTreeNode
  depth: number
  collapsed: Set<string>
  onToggle: (path: string) => void
  selectedKey: string | null
  onSelect: (key: string) => void
  selecting: boolean
  picked: Set<string>
  onPick: (node: McTreeNode) => void
  onRemove: (key: string) => void
  onContext: (node: McTreeNode, event: React.MouseEvent) => void
  isFavorite?: (key: string) => boolean
  onToggleFavorite?: (key: string) => void
}

/**
 * 树形单行（递归）。
 *
 * 行结构与 Redis 版 KeyTreeNode 一致：折叠箭头 / 文件夹 / 类型徽标 /
 * 键名 / TTL / 悬停删除。Memcached 没有类型，徽标统一显示 M；
 * TTL 由 metadump / cachedump 的到期时间换算，语义与 Redis 相同（永久 / 剩余秒数）。
 * 缩进、折叠箭头、目录计数的视觉完全一致。
 */
export function McTreeRow({
  node,
  depth,
  collapsed,
  onToggle,
  selectedKey,
  onSelect,
  selecting,
  picked,
  onPick,
  onRemove,
  onContext,
  isFavorite,
  onToggleFavorite,
}: McTreeRowProps) {
  const { t } = useI18n()
  const isDir = node.children.length > 0
  const isCollapsed = collapsed.has(node.path)
  const leaves = isDir ? collectLeaves(node) : node.leaf ? [node.leaf.key] : []
  const allPicked = leaves.length > 0 && leaves.every((key) => picked.has(key))
  const somePicked = !allPicked && leaves.some((key) => picked.has(key))
  const isSelected = !!node.leaf && selectedKey === node.leaf.key

  function handleClick(): void {
    if (selecting) {
      onPick(node)
      return
    }
    if (isDir) onToggle(node.path)
    else if (node.leaf) onSelect(node.leaf.key)
  }

  return (
    <>
      <div className="tree-node s-key-tree-node mc-tree-node">
        <div
          className={`node-row${isSelected ? ' active' : ''}${isDir && !node.leaf ? ' folder' : ''}${
            selecting && allPicked ? ' picked' : ''
          }`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={handleClick}
          onContextMenu={(event) => {
            if (selecting) return
            event.preventDefault()
            onContext(node, event)
          }}
        >
          {/* 折叠箭头：与 Redis 版同一形状（三角，展开时旋转 90°） */}
          {isDir ? (
            <button
              className="caret"
              onClick={(event) => {
                event.stopPropagation()
                onToggle(node.path)
              }}
            >
              <svg
                viewBox="0 0 12 12"
                className={`caret-ico${isCollapsed ? ' collapsed' : ''}`}
                aria-hidden="true"
              >
                <path d="M4.2 2.6 8.4 6l-4.2 3.4z" />
              </svg>
            </button>
          ) : (
            <span className="caret placeholder" />
          )}

          {/* 勾选模式：复选框占据文件夹图标的位置 */}
          {selecting ? (
            <label className="pick-box" onClick={(event) => event.stopPropagation()}>
              <input type="checkbox" checked={allPicked} onChange={() => onPick(node)} />
            </label>
          ) : null}

          {/*
            文件夹图标：与 Redis 版同一套形状 ——
            收起为闭合文件夹，展开为「上半盖 + 下半开口盒」。
            Memcached 的键名同样用分隔符分层，目录语义完全一致。
          */}
          {isDir ? (
            <svg
              viewBox="0 0 16 16"
              className={`folder-icon${isCollapsed ? ' collapsed' : ''}`}
              aria-hidden="true"
            >
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

          {/*
            键类型徽标：Memcached 只有一种值类型（不透明字节串），
            因此统一显示 M —— 与连接列表、日志里的引擎角标同一字母。
            底色借用 Redis 的 string 徽标色（type-string），
            两边键栏的徽标规格、颜色语义保持一致，切换引擎不产生"这套 UI 没做完"的感觉。
          */}
          {node.leaf && !isDir ? (
            <span className="type-badge type-string" {...tipProps(t('memcachedKeyBrowser.memcachedValue'))}>
              M
            </span>
          ) : null}

          <span className={`label mono ellipsis${isDir ? ' dir' : ''}`} {...tipProps(node.path || node.label)}>
            {node.label}
          </span>

          {isDir ? <span className="count mono">{countLeaves(node)}</span> : null}

          {/* 叶子右侧显示 TTL（与 Redis 同列、同格式）：永久键弱化、≤60s 用琥珀提醒 */}
          {node.leaf && !isDir ? (
            <span className={`ttl mono ${ttlTone(node.leaf.ttl)}`.trim()}>{formatTtl(node.leaf.ttl)}</span>
          ) : null}

          {node.leaf && !isDir ? (
            <button
              className={`key-fav${isFavorite?.(node.leaf.key) ? ' on' : ''}`}
              {...tipProps(
                isFavorite?.(node.leaf.key) ? t('favorites.remove') : t('favorites.add'),
              )}
              onClick={(event) => {
                event.stopPropagation()
                onToggleFavorite?.(node.leaf!.key)
              }}
            >
              <DialogIcon name="star" size={11} />
            </button>
          ) : null}

          {node.leaf && !isDir && !selecting ? (
            <button
              className="del-btn"
              {...tipProps(t('common.deleteThisKey'))}
              onClick={(event) => {
                event.stopPropagation()
                onRemove(node.leaf!.key)
              }}
            >
              {/* 与 Redis 键栏同一个删除图标（×），不用垃圾桶 —— 两边图标语义要一致 */}
              <DialogIcon name="cancel" size={10} />
            </button>
          ) : null}
        </div>
      </div>

      {isDir && !isCollapsed
        ? node.children.map((child) => (
            <McTreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              selectedKey={selectedKey}
              onSelect={onSelect}
              selecting={selecting}
              picked={picked}
              onPick={onPick}
              onRemove={onRemove}
              onContext={onContext}
              isFavorite={isFavorite}
              onToggleFavorite={onToggleFavorite}
            />
          ))
        : null}
    </>
  )
}
