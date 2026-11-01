import { useId } from 'react'
import { Switch } from '@/components/ui/switch'

export interface SwitchRowProps {
  title: string
  hint?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}

/** 整行可点的开关卡片：文字区域与开关共享同一个 label */
export function SwitchRow({
  title,
  hint,
  checked,
  onCheckedChange,
  disabled = false,
}: SwitchRowProps) {
  const id = useId()

  return (
    <label className={`switch-row${disabled ? ' is-disabled' : ''}`} htmlFor={id}>
      <span className="switch-row-text">
        <span className="switch-row-title">{title}</span>
        {hint ? <span className="switch-row-hint">{hint}</span> : null}
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </label>
  )
}

export default SwitchRow
