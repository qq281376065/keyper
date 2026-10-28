/**
 * 表头排序指示图标。
 *
 * 用 SVG 三角形而非 `⇅ / ↑ / ↓` 字符：
 * 字符箭头在不同字体下的粗细、基线位置都不一致，
 * 且「⇅」这个双向箭头在小字号下容易糊成一团；
 * 三角形是纯几何形状，缩放与对齐都可控。
 *
 * 三态：
 * - `none`：未参与排序 —— 上下双三角，极低透明度（弱提示"可点击排序"）
 * - `asc` ：升序 —— 实心上三角
 * - `desc`：降序 —— 实心下三角
 */
export function SortIcon({ direction }: { direction: 'asc' | 'desc' | null }) {
  return (
    <svg viewBox="0 0 12 12" className={`sort-tri ${direction ?? 'none'} s-sort-icon`} aria-hidden="true">
      {direction === 'asc' ? (
        /* 升序：上三角 */
        <path d="M6 2.6 10.2 8H1.8z" />
      ) : direction === 'desc' ? (
        /* 降序：下三角 */
        <path d="M6 9.4 1.8 4h8.4z" />
      ) : (
        /*未排序：上下两个小三角，暗示可双向排序。*/ <g>
          <path d="M6 1.6 9.1 5.2H2.9z" />
          <path d="M6 10.4 2.9 6.8h6.2z" />
        </g>
      )}
    </svg>
  )
}

export default SortIcon
