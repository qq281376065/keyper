import type { CacheConnectionConfig } from '@shared/types'

/**
 * 引擎图形：Redis = 层叠盘，Memcached = 内存芯片。
 * 连接列表放在名称行，引擎选择卡放在圆角底板上，共用同一套形状。
 */
export function EngineGlyph({
  engine,
  size = 15,
}: {
  engine: CacheConnectionConfig['engine']
  size?: number
}) {
  if (engine === 'memcached') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
        <rect
          x="2.2"
          y="3.2"
          width="11.6"
          height="9.6"
          rx="2.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <path
          d="M5.2 6.4h5.6M5.2 9.6h5.6"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2 14 5 8 8 2 5z" fill="currentColor" />
      <path
        d="M2 8l6 3 6-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2 11l6 3 6-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity=".5"
      />
    </svg>
  )
}
