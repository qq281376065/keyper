import { defineStore } from '@/store'

/**
 * 全局统一的自绘 tooltip。
 *
 * 为什么不用原生 `title`：
 * - 原生 tooltip 由操作系统绘制，**延迟约 1 秒**、样式完全不可控，
 *   暗色主题下会突兀地弹出一块亮色气泡；
 * - 无法控制换行宽度，长文本会拉成极宽的一行；
 * - 无法与项目已有的圆角 / 阴影 / 字体令牌保持一致。
 *
 * 设计要点：
 * - **单例**：整个应用只需要一个 tooltip 元素。若每个组件各持一份，
 *   就会在快速划过时出现多个气泡同时残留。
 * - **hover 即显示**：不做延迟。原生 tooltip 的 1 秒延迟在密集的
 *   图标工具栏上极其拖沓；本项目的提示都很短，立即显示不会造成干扰。
 * - **数据驱动**：React 版把「指令」换成 props/事件辅助函数（spread 到元素上），
 *   不新增 DOM 节点 —— 与 Vue 版指令的初衷一致（包一层会破坏 flex 布局，
 *   并让 `<button disabled>` 的禁用态无法正常穿透）。
 */

/** tooltip 相对锚点的位置偏好 */
export type TipPlacement = 'top' | 'bottom' | 'left' | 'right'

export interface TipState {
  /** 是否可见 */
  visible: boolean
  /** 提示文本；为空时即便 visible 也不渲染 */
  text: string
  /** 锚点元素，用于计算坐标 */
  anchor: HTMLElement | null
  /** 位置偏好 */
  placement: TipPlacement
  /** 是否强制单行（用于短标签，禁止换行） */
  nowrap: boolean
}

/** 全局唯一的提示状态 */
export const tipHolder = defineStore<TipState>({
  visible: false,
  text: '',
  anchor: null,
  placement: 'top',
  nowrap: false,
})

const state = tipHolder.store

/** 当前正在为哪个元素显示提示，用于避免重复触发与正确清理 */
let activeEl: HTMLElement | null = null

/** 计时器：用于关闭时的淡出 */
let hideTimer: number | null = null

function clearHideTimer(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer)
    hideTimer = null
  }
}

/**
 * 显示提示。
 *
 * @param el        锚点元素
 * @param text      提示文案
 * @param placement 位置偏好，默认上方
 * @param nowrap    是否禁止换行
 */
export function showTip(
  el: HTMLElement,
  text: string,
  placement: TipPlacement = 'top',
  nowrap = false,
): void {
  const content = String(text ?? '').trim()

  // 空文本不显示：调用方常绑定动态值（如 row.field），
  // 值为空时不应弹出一个空白气泡。
  if (!content) {
    hideTip(true)
    return
  }

  clearHideTimer()
  activeEl = el
  state.visible = true
  state.text = content
  state.anchor = el
  state.placement = placement
  state.nowrap = nowrap
}

/**
 * 隐藏提示。
 *
 * @param immediate 是否立即隐藏（不播放淡出）
 */
export function hideTip(immediate = false): void {
  activeEl = null
  if (!state.visible) return

  if (immediate) {
    clearHideTimer()
    state.visible = false
    state.anchor = null
    return
  }

  /*
   * 保留 anchor 与 text 让元素完成淡出动画，
   * 仅把 visible 置 false；下次 showTip 会整体覆盖状态。
   */
  clearHideTimer()
  state.visible = false
  hideTimer = window.setTimeout(() => {
    // 若期间没有新的显示请求，才真正清空内容
    if (!state.visible) {
      state.anchor = null
      state.text = ''
    }
    hideTimer = null
  }, 140)
}

/**
 * 滚动 / 改变尺寸时锚点会移动，而 tooltip 是 `fixed` 定位不会跟随。
 * 与其逐帧重算（代价高），不如直接把提示收掉 —— 用户此时注意力
 * 已在滚动行为上，气泡消失是符合预期的。
 *
 * 用捕获阶段（第三个参数 true）监听：键列表、表格等容器各自滚动，
 * 事件不会冒泡到 window，只有捕获阶段才能收到。
 */
function handleViewportChange(event: Event): void {
  if (!state.visible) return
  // 气泡自身不可能滚动（内容由 max-width 换行消化），无需响应
  if (event.target instanceof Node && document.querySelector('.app-tip')?.contains(event.target)) {
    return
  }
  hideTip(true)
}

window.addEventListener('scroll', handleViewportChange, true)
window.addEventListener('resize', handleViewportChange)

/** 当前提示的锚点元素 */
export function isActive(el: HTMLElement): boolean {
  return activeEl === el
}

/** 立刻收起提示（元素卸载时调用，避免悬空气泡） */
export function releaseTip(): void {
  hideTip(true)
}

/* ---------------------------------------------------------------- 绑定辅助 */

type TipInput =
  | string
  | number
  | undefined
  | null
  | { text: string; placement?: TipPlacement; nowrap?: boolean }

interface TipBinding {
  text: string
  placement: TipPlacement
  nowrap: boolean
}

/** 多行判定：短标签单行更整齐，超过阈值交给换行 */
const NOWRAP_LIMIT = 40

/** 把绑定值归一化成完整配置：既接受字符串，也接受对象 */
function normalize(value: TipInput): TipBinding {
  if (typeof value === 'string' || typeof value === 'number') {
    return { text: String(value), placement: 'top', nowrap: true }
  }

  if (value && typeof value === 'object') {
    return {
      text: String(value.text ?? ''),
      placement: value.placement ?? 'top',
      /*
       * 多行默认值：
       * 短文本（按钮/图标）单行更整齐，但超过一定长度就必须换行。
       * 这里按内容长度自动判断 —— 40 个字符以内视为短标签。
       */
      nowrap: value.nowrap !== undefined ? Boolean(value.nowrap) : String(value.text ?? '').length <= 40,
    }
  }

  return { text: '', placement: 'top', nowrap: true }
}

function resolveNowrap(cfg: TipBinding): boolean {
  return cfg.nowrap && cfg.text.length <= NOWRAP_LIMIT
}

/**
 * 生成「悬停显示提示」的事件处理器。
 *
 * 用法（等价于 Vue 的 `v-tip="'复制'"`）：
 *   <button {...tipProps('复制')}>…</button>
 *   <button {...tipProps({ text: hint, placement: 'bottom' })}>…</button>
 *
 * 注意：与原生 `title` **不可共存** —— 同时存在时浏览器仍会弹出
 * 原生提示，自绘气泡与系统气泡重叠。替换时务必把 `title` 删掉。
 */
export function tipProps(value: TipInput): {
  onMouseEnter: (event: React.MouseEvent<HTMLElement>) => void
  onMouseLeave: () => void
  onMouseDown: () => void
} {
  const cfg = normalize(value)
  return {
    onMouseEnter: (event) => {
      /*
       * 进入时二次校正：binding 更新时可能还没拿到最终文本
       * （如异步加载的字段名），进入时才是准确值。
       */
      showTip(event.currentTarget, cfg.text, cfg.placement, resolveNowrap(cfg))
    },
    onMouseLeave: () => hideTip(),
    /* 按下即收起：点击后弹出的菜单/弹窗会盖住气泡，
     * 让它留在原地会像一块没清掉的残留物。 */
    onMouseDown: () => hideTip(),
  }
}

/** 动态更新（文本变化时）——用于已经展开 props 的场合，如 tooltip 内容随状态变化 */
export function refreshTip(el: HTMLElement | null, value: TipInput): void {
  if (!el) return
  if (!isActive(el)) return
  const cfg = normalize(value)
  if (!cfg.text) hideTip()
  else showTip(el, cfg.text, cfg.placement, resolveNowrap(cfg))
}

export { state as tipState }

/** 元素引用的替代：React 里不需要指令式的 mounted/unmounted 生命周期，
 * 提示随元素卸载自然失效（hideTip 在 scroll/resize 与 mousedown 时清理）。 */
