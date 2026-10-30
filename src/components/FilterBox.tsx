import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'

/**
 * 值区通用的内容搜索框。
 *
 * Redis 与 Memcached 的值区都使用这一个组件：输入即过滤、带清除按钮。
 * 抽出来是为了避免两边各写一套后样式与交互漂移 ——
 * 换引擎时，搜索框的形状、位置、清除行为应当保持不变。
 */
export interface FilterBoxProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  className?: string
}

export function FilterBox({ value, onChange, placeholder, className }: FilterBoxProps) {
  const { t } = useI18n()

  return (
    <label className={`search-box${className ? ` ${className}` : ''}`}>
      <svg viewBox="0 0 16 16" className="s-icon" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 14 14" />
      </svg>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="filter mono"
        placeholder={placeholder}
      />
      {value ? (
        <button className="s-clear" {...tipProps(t('清除搜索'))} onClick={() => onChange('')}>
          <DialogIcon name="cancel" size={10} />
        </button>
      ) : null}
    </label>
  )
}

export default FilterBox
