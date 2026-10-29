import * as React from "react"
import { cn } from "@/lib/utils"
import { useAutoGrow } from "@/hooks/useAutoGrow"

function Textarea({
  className,
  autoGrow = false,
  value,
  ...props
}: React.ComponentProps<"textarea"> & {
  /**
   * 随内容增高（有上限，见 .dlg .dlg-content 的 max-height）。
   *
   * 默认关闭：多数 textarea 内容短、高度固定反而更好预期。
   * 弹窗里的值编辑器内容长度差异极大（一行短值 ↔ 整段 JSON），
   * 固定高度会让人不停内部滚动找人，故这些地方显式开启。
   */
  autoGrow?: boolean
}) {
  const growRef = useAutoGrow<HTMLTextAreaElement>(typeof value === "string" ? value : "")

  return (
    <textarea
      data-slot="textarea"
      ref={autoGrow ? growRef : undefined}
      value={value}
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
