import { createPortal } from 'react-dom'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'

/**
 * 值区通用小组件（从 ValueViewer 拆出，JSX 与行为原样保留）。
 * 骨架屏 / 自动刷新开关 / 行菜单遮罩 / 加载更多按钮 / 书签名截断。
 */

/** 骨架屏：读取中保留尺寸，避免内容出现时的跳变 */
export function SkeletonValue() {
  return (
    <>
      {/* 骨架沿用头部外壳，数据到达时不跳高度 */}
      <header className="viewer-head">
        <div className="key-line">
          <span className="sk sk-badge" />
          <span className="sk sk-title" />
        </div>
        <div className="meta-line">
          <span className="sk sk-meta" />
        </div>
      </header>

      <div className="value-toolbar">
        <span className="sk sk-tool" />
        <span className="sk sk-tool" />
        <span className="sk sk-tool" />
      </div>

      <div className="value-body">
        <div className="sk-table">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <span key={n} className="sk sk-row" style={{ animationDelay: `${n * 70}ms` }} />
          ))}
        </div>
      </div>
    </>
  )
}

/** 自动刷新开关（hash / list / set / zset / stream 共用） */
export function AutoRefreshSwitch({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  const { t } = useI18n()
  return (
    <label className={`switch${value ? ' on' : ''}`} {...tipProps(t('valueViewer.updatesListAutomaticallyEvery5'))}>
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
      <span className="track">
        <span className="thumb" />
      </span>
      <span className="switch-label">{t('valueViewer.autoRefresh')}</span>
      {value ? <span className="switch-dot" /> : null}
    </label>
  )
}

/** 行右键菜单的遮罩层：点击空白或再次右键均关闭 */
export function RowMenuMask({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return createPortal(
    <div
      className="row-menu-mask s-value-viewer"
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      {children}
    </div>,
    document.body,
  )
}