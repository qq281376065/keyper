import { createPortal } from 'react-dom'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import { typeAbbr, typeLabel } from '@/utils/typeLabel'
import type { KeyTreeNode as KeyTreeNodeModel } from '@/utils/keyTree'
import type { RedisKeyItem } from '@shared/types'

/**
 * 键右键菜单（从 KeyBrowser 拆出，JSX 与行为原样保留）。
 *
 * 树形与平铺共用同一份菜单，避免递归节点各挂一个浮层。
 * 定位测量（menuRef）与动作回调仍由 KeyBrowser 持有 —— 菜单关闭后
 * 要回到触发它的键上继续操作，状态不能散进子组件。
 */

/**
 * 菜单目标：要么是**单个真实键**（平铺项 / 深层叶子），
 * 要么是**一棵子树**（顶层节点，删除语义为批量删除该前缀下的全部键）。
 */
export type KeyMenuTarget =
  | { kind: 'key'; item: RedisKeyItem; keys: string[] }
  | { kind: 'subtree'; node: KeyTreeNodeModel; keys: string[] }

export interface KeyContextMenuProps {
  menu: { target: KeyMenuTarget; top: number; left: number }
  menuRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
  /** 单键动作包装：执行后关闭菜单（由父组件提供，保持原 runSingleKeyAction 语义） */
  runSingleKeyAction: (action: (item: RedisKeyItem) => void) => void
  runPrefixAction: (action: (node: KeyTreeNodeModel) => void) => void
  runKeyMenuAction: (action: (target: KeyMenuTarget) => void) => void
  onViewValue: (item: RedisKeyItem) => void
  onCopyName: (item: RedisKeyItem) => void
  onCopyValue: (item: RedisKeyItem) => void
  onCopyCommand: (item: RedisKeyItem) => void
  onToggleFavorite: (key: string) => void
  onRename: (item: RedisKeyItem) => void
  onSetTtl: (item: RedisKeyItem) => void
  onCreateUnder: (node: KeyTreeNodeModel) => void
  onCopyPrefix: (node: KeyTreeNodeModel) => void
  onCopySubtreeKeys: (node: KeyTreeNodeModel) => void
  onDelete: (target: KeyMenuTarget) => void
  /** 当前右键目标是否已收藏（菜单文案随状态切换） */
  favorited: boolean
}

export function KeyContextMenu({
  menu,
  menuRef,
  onClose,
  runSingleKeyAction,
  runPrefixAction,
  runKeyMenuAction,
  onViewValue,
  onCopyName,
  onCopyValue,
  onCopyCommand,
  onToggleFavorite,
  onRename,
  onSetTtl,
  onCreateUnder,
  onCopyPrefix,
  onCopySubtreeKeys,
  onDelete,
  favorited,
}: KeyContextMenuProps) {
  const { t } = useI18n()

  const menuHead = (() => {
    const target = menu.target
    if (target.kind === 'key') {
      return { key: target.item.key, type: target.item.type as string, count: 0, isSubtree: false }
    }
    return { key: target.node.path, type: '', count: target.keys.length, isSubtree: true }
  })()

  return createPortal(
    <div
      className="key-menu-mask s-key-browser"
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div
        ref={menuRef}
        className="key-menu s-key-browser"
        style={{ top: `${menu.top}px`, left: `${menu.left}px` }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="km-head">
          {!menuHead.isSubtree ? (
            <span className={`type-badge type-${menuHead.type}`} {...tipProps(typeLabel(menuHead.type))}>
              {typeAbbr(menuHead.type)}
            </span>
          ) : (
            <DialogIcon name="folder" size={13} className="km-prefix-icon" />
          )}
          <span className="mono ellipsis" {...tipProps(menuHead.key)}>
            {menuHead.key}
          </span>
        </div>

        {!menuHead.isSubtree ? (
          <>
            <button className="km-item" onClick={() => runSingleKeyAction(onViewValue)}>
              <DialogIcon name="eye" size={14} className="km-icon" />
              <span>{t('keyBrowser.viewValue')}</span>
            </button>

            <div className="km-group">{t('common.copy')}</div>
            <button className="km-item" onClick={() => runSingleKeyAction((item) => onCopyName(item))}>
              <DialogIcon name="text" size={14} className="km-icon" />
              <span>{t('common.copyKeyName')}</span>
            </button>
            <button className="km-item" onClick={() => runSingleKeyAction((item) => onCopyValue(item))}>
              <DialogIcon name="copy" size={14} className="km-icon" />
              <span>{t('keyBrowser.copyKeyValue')}</span>
            </button>
            <button className="km-item" onClick={() => runSingleKeyAction((item) => onCopyCommand(item))}>
              <DialogIcon name="terminal" size={14} className="km-icon" />
              <span>{t('keyBrowser.copyCommand')}</span>
            </button>

            <div className="km-group">{t('keyBrowser.manage')}</div>
            <button className="km-item" onClick={() => runSingleKeyAction((item) => onToggleFavorite(item.key))}>
              <DialogIcon name="star" size={14} className="km-icon" />
              <span>{favorited ? t('favorites.remove') : t('favorites.add')}</span>
            </button>
            <button className="km-item" onClick={() => runSingleKeyAction(onRename)}>
              <DialogIcon name="edit" size={14} className="km-icon" />
              <span>{t('common.renameKey')}</span>
            </button>
            <button className="km-item" onClick={() => runSingleKeyAction(onSetTtl)}>
              <DialogIcon name="clock" size={14} className="km-icon" />
              <span>{t('common.setTtl')}</span>
            </button>
          </>
        ) : (
          <>
            <button className="km-item" onClick={() => runPrefixAction(onCreateUnder)}>
              <DialogIcon name="add" size={14} className="km-icon" />
              <span>{t('keyBrowser.addNewKey')}</span>
            </button>

            <div className="km-group">{t('common.copy')}</div>
            <button className="km-item" onClick={() => runPrefixAction((node) => onCopyPrefix(node))}>
              <DialogIcon name="text" size={14} className="km-icon" />
              <span>{t('keyBrowser.copyPrefix')}</span>
            </button>
            <button className="km-item" onClick={() => runPrefixAction((node) => onCopySubtreeKeys(node))}>
              <DialogIcon name="copy" size={14} className="km-icon" />
              <span>{t('keyBrowser.copyAllKeyNames')}</span>
            </button>
          </>
        )}

        <div className="km-sep" />

        <button className="km-item danger" onClick={() => runKeyMenuAction((target) => onDelete(target))}>
          <DialogIcon name="trash" size={14} className="km-icon" />
          <span>
            {menuHead.isSubtree
              ? t('common.bulkDeleteCountKeys', { count: menuHead.count })
              : t('common.deleteKey')}
          </span>
        </button>
      </div>
    </div>,
    document.body,
  )
}