import { useMemo, useState } from 'react'
import { DialogShell } from '@/components/DialogShell'
import { DialogIcon } from '@/components/DialogIcon'
import { Button } from '@/components/ui/button'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import { useRedis } from '@/store/useRedis'
import { copyText } from '@/utils/clipboard'
import { formatBytes, utf8Bytes } from '@/utils/format'
import type { JsonTreeNode } from '@/utils/jsonTree'

export interface TreeValueDialogProps {
  /** 长值所在的树节点（key / path / fullText） */
  node: JsonTreeNode
  onClose: () => void
}

/**
 * 树形视图长值查看弹窗。
 *
 * 用项目统一 DialogShell（图标标题 + 副标题 + 可滚动正文 + 固定页脚 + 拖拽），
 * 与 ViewStreamEntryDialog 同一套视觉语言 —— 此前自绘的 jt-dlg 过于简陋，
 * 高度与居中也不符合弹窗规范，整体替换。
 *
 * 正文两种视图：
 *   · 原文：完整字符串（去引号、控制字符已 sanitize），等宽预格式化
 *   · JSON：值本身是合法 JSON 对象/数组时提供美化视图（嵌套字符串值常见）
 */
export function TreeValueDialog({ node, onClose }: TreeValueDialogProps) {
  const { t } = useI18n()
  const { notify } = useRedis()
  const [view, setView] = useState<'raw' | 'json'>('raw')
  const [wrap, setWrap] = useState(true)

  /* fullText 含展示引号；正文用去引号的原始内容 */
  const rawText = useMemo(() => {
    const text = node.fullText ?? node.leafText ?? ''
    return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text
  }, [node])

  /* 值本身是 JSON 对象/数组时提供美化视图 */
  const jsonText = useMemo(() => {
    const trimmed = rawText.trim()
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return null
    }
  }, [rawText])

  const shown = view === 'json' && jsonText ? jsonText : rawText
  const stats = {
    chars: rawText.length,
    bytes: utf8Bytes(rawText),
    lines: rawText ? rawText.split('\n').length : 0,
  }

  async function copy(): Promise<void> {
    const done = await copyText(shown)
    notify(
      done ? 'ok' : 'err',
      done ? t('valueFormats.treeCopied') : t('common.copyFailedCheckClipboardPermissions'),
    )
  }

  return (
    <DialogShell
      icon="document"
      title={t('valueFormats.treeDialogTitle')}
      description={t('valueFormats.treeDialogDesc')}
      badge={<span className="dlg-badge mono">{node.kind}</span>}
      className="tree-value-dialog s-tree-value-dialog"
      closeOnOverlay
      onClose={onClose}
      footer={
        <>
          <span className="stat mono">{t('common.countCharacters', { count: stats.chars })}</span>
          <span className="sep">·</span>
          <span className="stat mono">{t('editListElementDialog.countLines', { count: stats.lines })}</span>
          <span className="sep">·</span>
          <span className="stat mono">{formatBytes(stats.bytes)}</span>
          <span className="spacer" />
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={() => void copy()}>
            <DialogIcon name="copy" size={13} />
            {t('common.copy')}
          </Button>
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onClose}>
            <DialogIcon name="cancel" size={13} />
            {t('common.close')}
          </Button>
        </>
      }
    >
      {/* 节点定位：键名 + 树内路径 */}
      <div className="tvd-node">
        <span className="tvd-key mono ellipsis" {...tipProps(node.key)}>
          {node.key}
        </span>
        <span className="tvd-path mono ellipsis" {...tipProps(node.path)}>
          {node.path}
        </span>
      </div>

      {/* 视图工具条：原文 / JSON 美化（可用时）+ 自动换行 */}
      <div className="tvd-toolbar">
        <div className="tvd-seg">
          <button
            type="button"
            className={`tvd-seg-btn${view === 'raw' ? ' on' : ''}`}
            onClick={() => setView('raw')}
          >
            {t('valueFormats.raw')}
          </button>
          {jsonText ? (
            <button
              type="button"
              className={`tvd-seg-btn${view === 'json' ? ' on' : ''}`}
              onClick={() => setView('json')}
            >
              JSON
            </button>
          ) : null}
        </div>
        <span className="spacer" />
        <button
          type="button"
          className={`tvd-wrap-btn${wrap ? ' on' : ''}`}
          onClick={() => setWrap((prev) => !prev)}
          {...tipProps(t('valueFormats.treeWrapHint'))}
        >
          <DialogIcon name="text" size={12} />
          {t('valueFormats.treeWrap')}
        </button>
      </div>

      <pre className={`tvd-body mono${wrap ? '' : ' nowrap'}`}>{shown}</pre>
    </DialogShell>
  )
}

export default TreeValueDialog