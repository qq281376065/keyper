import { Component, type ErrorInfo, type ReactNode } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { reportRendererError } from '@/services/errorReport'
import { globalState, globalHolder } from '@/store/global'
import { useObservable } from '@/store/subscription'

/**
 * 渲染层错误边界：组件树任何异常在此拦截，
 * 显示顶部横幅而非整窗白屏。
 *
 * 相同错误 5 秒内只报一次：渲染错误常在更新循环里连环触发，
 * 横幅反复重建比白屏更干扰。
 *
 * 静音窗（2026-10 用户报修「复制详情/关闭点了没反应」）：
 * 出错组件未卸载时，任何重渲染 —— 包括点「关闭」清掉错误态
 * 触发的那次 —— 都会再抛同一个错，横幅立刻重建，用户视角即
 * 「按钮无反应」。关闭/复制后 30 秒内同错误只落盘不再重弹横幅，
 * 用户至少能操作界面去恢复（切页签/重开弹窗）。
 */
interface State {
  message: string
  detail: string
}

let lastErrorAt = 0
let lastErrorText = ''
/** 用户显式关闭/复制后的静音截止时刻（毫秒时间戳） */
let errorMutedUntil = 0

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { message: '', detail: '' }

  static getDerivedStateFromError(error: unknown): State | null {
    const text = error instanceof Error ? error.message : String(error)
    const now = Date.now()
    if (text !== lastErrorText || now - lastErrorAt > 5000) {
      lastErrorAt = now
      lastErrorText = text
      reportRendererError(error, 'errorBoundary')
      if (now > errorMutedUntil) {
        return {
          message: text,
          detail: error instanceof Error ? (error.stack ?? text) : text,
        }
      }
    }
    return null
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[渲染层错误]', info.componentStack, error)
  }

  /** 关闭错误横幅：置空 + 进入 30 秒静音窗（防出错组件重渲染把横幅顶回来） */
  dismiss = (): void => {
    errorMutedUntil = Date.now() + 30_000
    this.setState({ message: '', detail: '' })
  }

  render(): ReactNode {
    if (!this.state.message) return this.props.children
    return (
      <>
        <RenderErrorBar
          message={this.state.message}
          detail={this.state.detail}
          onDismiss={this.dismiss}
        />
        {this.props.children}
      </>
    )
  }
}

/** 横幅本体单独抽一层，便于用订阅钩子跟随全局 toast */
function RenderErrorBar({
  message,
  detail,
  onDismiss,
}: {
  message: string
  detail: string
  onDismiss: () => void
}) {
  useObservable(globalHolder)

  /** 极简 toast（横幅动作的反馈就地实现，不依赖会话上下文） */
  let errorToastTimer: ReturnType<typeof setTimeout> | undefined
  function flashToast(kind: 'ok' | 'err', text: string): void {
    globalState.toast = { kind, text }
    window.clearTimeout(errorToastTimer)
    errorToastTimer = setTimeout(() => {
      globalState.toast = null
    }, 3200)
  }

  /** execCommand 复制兜底：clipboard API 在非安全上下文/无聚焦会静默 reject */
  function copyViaExecCommand(text: string): boolean {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }

  /**
   * 复制错误详情：clipboard API → execCommand 双保险，结果给 toast 反馈。
   * 成功才关横幅（进静音窗）；失败横幅保留（用户还可手选文本）。
   */
  async function copyRenderError(): Promise<void> {
    let copied = false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(detail)
        copied = true
      }
    } catch {
      /* 落到 execCommand 兜底 */
    }
    if (!copied) copied = copyViaExecCommand(detail)
    if (copied) {
      flashToast('ok', '错误详情已复制')
      onDismiss()
    } else {
      flashToast('err', '复制失败，请展开详情手动选择')
    }
  }

  return (
    <div className="render-error-bar">
      <DialogIcon name="warning" size={14} className="bar-icon" />
      <span className="render-error-text" title={detail}>
        界面发生错误：{message}
      </span>
      <button className="btn btn-ghost tiny" onClick={copyRenderError}>
        <DialogIcon name="copy" size={12} />
        复制详情
      </button>
      <button className="btn btn-ghost tiny" onClick={onDismiss}>
        <DialogIcon name="cancel" size={12} />
        关闭
      </button>
    </div>
  )
}
