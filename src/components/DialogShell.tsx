import type { ReactNode } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { DialogIcon, type DialogIconName } from '@/components/DialogIcon'
import { useDialogDrag } from '@/hooks/useDialogDrag'

export interface DialogShellProps {
  /** 标题栏图标 */
  icon: DialogIconName
  title: string
  /** 副标题：一句话说明这个弹窗要做什么 */
  description: string
  /** 标题右侧的上下文徽标（如 db0、key 类型） */
  badge?: ReactNode
  /** 头部下方、滚动区之上的常驻条（提示 / 结果抽屉） */
  notice?: ReactNode
  children: ReactNode
  /** 页脚按钮组，从右往左排 */
  footer: ReactNode
  onClose: () => void
  /** 附加在弹窗外壳上的类名，用于个别弹窗的尺寸微调 */
  className?: string
  /** 点击遮罩是否关闭。默认不关（表单可能已填一半） */
  closeOnOverlay?: boolean
  /** 无障碍描述 id，默认由 title 派生 */
  describedById?: string
}

/**
 * 弹窗统一外壳。
 *
 * 抽出来的原因：本次迁移的 7 个弹窗骨架完全相同 ——
 * 头部（图标 + 标题 + 副标题 + 关闭）、可滚动正文、固定页脚。
 * 若每个文件各写一遍，样式与对齐细节很快就分叉（这正是先前
 * 11 个旧弹窗各自为政的由来）。这里把结构、拖拽、关闭语义收敛到一处，
 * 各弹窗只关心自己的正文与页脚。
 *
 * 视觉规范见 src/styles/connection-dialog.css 的 .dlg-* 系列；
 * 关闭按钮的红色悬停、头部图标与标题的齐平都已在样式里处理好。
 */
export function DialogShell({
  icon,
  title,
  description,
  badge,
  notice,
  children,
  footer,
  onClose,
  className = '',
  closeOnOverlay = false,
  describedById,
}: DialogShellProps) {
  const { style, onDragStart } = useDialogDrag()
  const descId = describedById ?? 'dlg-desc'

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent
        className={`dialog dlg ${className}`.trim()}
        style={style}
        showCloseButton={false}
        /* 默认点遮罩不关闭：表单类弹窗误触外部导致内容全丢的代价太高 */
        onPointerDownOutside={
          closeOnOverlay ? undefined : (event) => event.preventDefault()
        }
        aria-describedby={descId}
      >
        <div className="dlg-shell">
          <header className="dlg-head" onMouseDown={onDragStart}>
            <div className="dlg-head-main">
              <div className="dlg-head-top">
                <span className="dlg-head-icon">
                  <DialogIcon name={icon} size={15} />
                </span>
                <DialogTitle className="dlg-title">{title}</DialogTitle>
                {badge}
              </div>
              <DialogDescription id={descId} className="dlg-sub">
                {description}
              </DialogDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="dlg-close"
              aria-label="关闭"
              onClick={onClose}
            >
              <DialogIcon name="cancel" size={13} />
            </Button>
          </header>

          {/* 常驻提示条：位于头部之下、滚动区之上，表单再长也始终可见 */}
          {notice}

          <div className="dlg-body">{children}</div>

          <footer className="dlg-foot">{footer}</footer>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default DialogShell
