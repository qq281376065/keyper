import type { CacheConnectionConfig } from '@shared/types'
import { EngineGlyph } from '@/components/EngineGlyph'
import { engineMeta } from '@/utils/engine'

/** 带真实引擎图形与配色的小标签，用于需要文字说明引擎的列表/摘要 */
export function EngineTag({ engine }: { engine: CacheConnectionConfig['engine'] }) {
  return (
    <span className={`engine-tag engine-${engine}`}>
      <EngineGlyph engine={engine} size={11} />
      {engineMeta(engine).label}
    </span>
  )
}

export default EngineTag
