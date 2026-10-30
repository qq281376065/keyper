import { useCallback, useEffect, useRef, useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { useI18n } from '@/i18n'

export interface NoticeDrawerProps {
  /** 成功（绿）/ 失败（红） */
  ok: boolean
  text: string
  /** 自动收起延时（ms）。0 表示不自动收起 */
  life?: number
  onDismiss: () => void
}

/**
 * 会自己收起的提示抽屉（表单顶部的操作结果反馈）。
 *
 * 交互设计：
 *   · 进场从头部下方抽拉展开（max-height 动画），不遮挡内容；
 *   · 停留 `life` 毫秒后播放离场动画，**动画结束才卸载** —— 直接置空
 *     会让提示"瞬移消失"，看起来像闪了一下；
 *   · 鼠标悬停时暂停倒计时：用户正在读，不该被抽走；
 *   · 底部有一条同步的进度条，把"还剩多久"可视化，收起时不突兀。
 *
 * 卸载时机用 animationend 而不是 setTimeout：
 * 系统开启「减少动态效果」时动画时长为 0，animationend 会立即触发，
 * 而 setTimeout(260) 会白等一段 —— 两者都靠事件，行为才一致。
 */
export function NoticeDrawer({ ok, text, life = 4000, onDismiss }: NoticeDrawerProps) {
  const { t } = useI18n()
  const [leaving, setLeaving] = useState(false)

  /** 剩余停留时间；悬停暂停时用它做续播 */
  const remaining = useRef(life)
  const startedAt = useRef(Date.now())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 离场动画的兜底卸载定时器 */
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  /**
   * 进入离场：切换类名播放收起动画，并在动画时长之后兜底卸载。
   *
   * 为什么不能只靠 animationend：
   * 实测离场动画虽已 finished，事件却没送达 React 的 onAnimationEnd
   * （同元素上的进度条动画也在跑 forwards，事件并不总会冒泡到根）。
   * 结果抽屉高度归零后仍挂在 DOM 里，虽不可见却持续占位。
   *
   * 双保险：animationend 优先（时机最准），定时器兜底（保证一定卸载）。
   * 4 除的下标用 260ms，比 0.24s 动画多留 20ms 余量。
   */
  const beginLeave = useCallback(() => {
    clear()
    setLeaving(true)
    leaveTimer.current = setTimeout(() => onDismiss(), 260)
  }, [clear, onDismiss])

  /** 启动（或续播）倒计时 */
  const start = useCallback(
    (delay: number) => {
      if (!life) return
      clear()
      startedAt.current = Date.now()
      timer.current = setTimeout(beginLeave, Math.max(0, delay))
    },
    [beginLeave, clear, life],
  )

  // 首次挂载即开始计时
  useEffect(() => {
    if (!life) return
    start(life)
    return () => {
      clear()
      if (leaveTimer.current) clearTimeout(leaveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 悬停暂停：把已流逝的时间从剩余量里扣掉 */
  function handleEnter(): void {
    if (!life || leaving) return
    clear()
    remaining.current -= Date.now() - startedAt.current
  }

  /** 移出续播：用剩余量重新计时，不会从头再等一遍 */
  function handleLeave(): void {
    if (!life || leaving) return
    start(Math.max(600, remaining.current))
  }

  return (
    <div
      className={`notice-flyout ${ok ? 'is-ok' : 'is-err'}${leaving ? ' is-leaving' : ''}`}
      role="status"
      aria-live="polite"
      style={{ '--drawer-life': `${life}ms` } as React.CSSProperties}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      /* 动画结束即卸载；reduced-motion 下时长 0，同样会触发 */
      onAnimationEnd={(event) => {
        // 只响应抽屉自身的动画，忽略子元素冒泡（进度条也在跑动画）
        if (event.target !== event.currentTarget) return
        if (leaving) onDismiss()
      }}
    >
      <span className="flyout-glyph">
        <DialogIcon name={ok ? 'check' : 'warning'} size={14} />
      </span>
      <span className="flyout-text">{text}</span>
      <button type="button" className="flyout-close" aria-label={t('关闭提示')} onClick={beginLeave}>
        <DialogIcon name="cancel" size={11} />
      </button>
    </div>
  )
}

export default NoticeDrawer
