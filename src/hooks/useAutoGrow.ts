/*
 * textarea 随内容自动增高。
 *
 * 弹窗里的内容常常是一整段 JSON 或一条很长的列表元素。固定 110px 高时
 * 用户只能看到前五六行，其余要靠内部滚动条翻 —— 但「我要改的是结尾那个字段」
 * 是这类的典型场景，滚动找人比直接看全文慢得多。
 *
 * 上限由 CSS 的 max-height 决定（.dlg .dlg-content），到顶后回到内部滚动：
 * 弹窗本身高度有限，无限增高会把页脚按钮顶出视口。
 *
 * 实现要点：
 *   · 量高前先 height:auto，否则 scrollHeight 会被上一次的 height 卡住，
 *     内容变短时不会收缩（只会越长越大）；
 *   · 用 useLayoutEffect 而不是 useEffect：在浏览器绘制前就定好高度，
 *     避免打开弹窗时先闪一下 110px 再跳成实际高度；
 *   · ResizeObserver 观察父元素（宽度）而不是 textarea 自己：
 *     在回调里改被观察元素的高度会自激触发下一轮回调。
 *     宽度变化才需要重算 —— 折行数跟着变，高度得重新量。
 */
import { useLayoutEffect, useRef } from 'react'

export function useAutoGrow<T extends HTMLTextAreaElement>(value: string) {
  const ref = useRef<T | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const apply = (): void => {
      /* 先归零，让 scrollHeight 反映真实内容高度 */
      el.style.height = 'auto'
      const next = el.scrollHeight
      /*
       * 值没变就不写回。
       * 写回一个和当前相同的高度仍会触发一次样式重算，
       * 在 ResizeObserver 回调里那就是无谓的抖动来源。
       */
      if (el.offsetHeight !== next) el.style.height = `${next}px`
    }

    apply()

    const parent = el.parentElement
    if (!parent) return
    const observer = new ResizeObserver(apply)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [value])

  return ref
}

export default useAutoGrow
