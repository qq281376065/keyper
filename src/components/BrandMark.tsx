import { useId } from 'react'

/**
 * Keyper 品牌图标（K 形钥匙）—— 矢量版，配色跟随皮肤。
 *
 * 为什么从 PNG 背景图改成内联 SVG：
 * 原来 `.s-welcome-panel .logo` 用 `background-image: url(keyper-icon.png)`，
 * 颜色烤死在图里，切皮肤时图标永远是一块金铜。改成 SVG 后渐变两端取自
 * `--brand-from` / `--brand-to`，9 套皮肤各配一组，切主题图标跟着走。
 *
 * 几何与 `scripts/make-icon.py`（生成 ico 的那份）完全一致，同为 128×128 坐标系：
 *   - 圆角矩形 128×128 r=30      底
 *   - capsule (40,32)-(40,96) w14 竖笔
 *   - capsule (88,34)-(54,64) + (54,64)-(88,94) w14 上下斜笔（拼出 K）
 *   - capsule (74,45)-(90,45) + (77,55)-(88,55) w5 齿痕
 *
 * 两个容易踩的点：
 *
 * 1. **渐变必须用 userSpaceOnUse**。若用默认的 objectBoundingBox，
 *    齿痕那两条 16×5 的短笔画会各自把整段渐变压进自己的包围盒，颜色完全对不上，
 *    看起来像贴了两块异色补丁。改成绝对坐标系后，齿痕引用同一渐变即得"该处的真实底色"。
 *
 * 2. **stop-color 走 CSS 而非属性**。写死 stopColor 就没法跟随主题；
 *    交给类名 + CSS 变量，改皮肤时不用重渲染组件。
 *
 * 符号色 `--brand-fg` 默认白。亮色皮肤（如 forest/薄荷）若白字对比不足，
 * 只需在主题块里覆盖这一个变量，不必改组件。
 */
export function BrandMark({ className }: { className?: string }) {
  // useId 带冒号（:r1:），塞进 url(#...) 会被当成伪类解析，去掉
  const uid = useId().replace(/:/g, '')
  const grad = `bm-g-${uid}`
  const glow = `bm-h-${uid}`
  const clip = `bm-c-${uid}`

  return (
    <svg
      className={className}
      viewBox="0 0 128 128"
      role="img"
      aria-label="Keyper"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={grad} gradientUnits="userSpaceOnUse" x1="12" y1="8" x2="116" y2="120">
          <stop offset="0" className="bm-from" />
          <stop offset="1" className="bm-to" />
        </linearGradient>
        {/* 顶部柔光：让纯渐变不至于太平，一层很淡的径向高光就够。
            强度由 --brand-glow 控制 —— 磨砂玻璃皮肤要把它拉到 0.85 才像一块玻璃片，
            普通皮肤保持 0.26 的轻高光。 */}
        <radialGradient id={glow} cx="0.5" cy="0.05" r="0.75">
          <stop offset="0" stopColor="#FFFFFF" style={{ stopOpacity: 'var(--brand-glow, 0.26)' }} />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <clipPath id={clip}>
          <rect width="128" height="128" rx="30" />
        </clipPath>
      </defs>

      <g clipPath={`url(#${clip})`}>
        <rect className="bm-plate" width="128" height="128" fill={`url(#${grad})`} />
        <rect className="bm-glow" width="128" height="128" fill={`url(#${glow})`} />
        {/*
          玻璃质感的内描边：一道 1.5px 白线压在渐变边缘内侧，模拟玻璃片的棱。
          opacity 由 --brand-edge 控制，普通皮肤默认 0（完全不显示），
          只有磨砂玻璃皮肤把它打开。
        */}
        <rect
          className="bm-edge"
          x="0.75"
          y="0.75"
          width="126.5"
          height="126.5"
          rx="29.5"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="1.5"
          style={{ opacity: 'var(--brand-edge, 0)' }}
        />

        {/* K：竖笔 + 上下斜笔 */}
        <path
          d="M40 32v64"
          stroke="var(--brand-fg, #FFFFFF)"
          strokeWidth="14"
          strokeLinecap="round"
        />
        <path
          d="M88 34L54 64l34 30"
          stroke="var(--brand-fg, #FFFFFF)"
          strokeWidth="14"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* 齿痕：用同一渐变描边 = 从笔画里"挖掉"露出底色 */}
        <path
          d="M74 45h16M77 55h11"
          stroke={`url(#${grad})`}
          strokeWidth="5"
          strokeLinecap="round"
        />
      </g>
    </svg>
  )
}
