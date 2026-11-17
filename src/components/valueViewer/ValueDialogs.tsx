import { EditHashFieldDialog } from '@/components/EditHashFieldDialog'
import { EditHashFieldTtlDialog } from '@/components/EditHashFieldTtlDialog'
import { EditListElementDialog } from '@/components/EditListElementDialog'
import { EditValueDialog } from '@/components/EditValueDialog'
import { EditZsetMemberDialog } from '@/components/EditZsetMemberDialog'
import { PromptDialog } from '@/components/PromptDialog'
import { StreamAddEntryDialog } from '@/components/StreamAddEntryDialog'
import { ViewStreamEntryDialog } from '@/components/ViewStreamEntryDialog'
import { useI18n } from '@/i18n'
import type { MsgKey } from '@shared/i18n'
import type { KeyValue } from '@shared/types'
import type { useHashEditor } from '@/hooks/valueEditor/hash'
import type { useListEditor } from '@/hooks/valueEditor/list'
import type { useSetEditor } from '@/hooks/valueEditor/set'
import type { useStreamEditor } from '@/hooks/valueEditor/stream'
import type { useZsetEditor } from '@/hooks/valueEditor/zset'

/**
 * 值区弹窗集合（从 ValueViewer 拆出，行为与 JSX 原样保留）。
 *
 * 拆分边界：只搬「弹窗渲染」，不搬状态 —— 各编辑器的开关状态仍由
 * ValueDetailPane 里的 editor hooks 持有，这里只接收实例与回调。
 * 这样自动刷新的「有弹窗打开则跳过」判定（tickAutoRefresh）不需要
 * 跨组件同步状态，语义与拆分前完全一致。
 */

/** TTL 常用值：省去用户心算秒数 */
const TTL_PRESETS: Array<{ label: MsgKey; value: string }> = [
  { label: 'common.oneMinute', value: '60' },
  { label: 'common.fiveMinutes', value: '300' },
  { label: 'common.thirtyMinutes', value: '1800' },
  { label: 'common.oneHour', value: '3600' },
  { label: 'common.oneDay', value: '86400' },
  { label: 'common.sevenDays', value: '604800' },
  { label: 'common.noExpiration', value: '0' },
]

export interface ValueDialogsProps {
  value: KeyValue
  /** 整值编辑弹窗开关（string 的「编辑」走内联 textarea，这里是容器类型的整值编辑） */
  editVisible: boolean
  onCloseEdit: () => void
  renameVisible: boolean
  ttlVisible: boolean
  trimVisible: boolean
  onRename: (next: string) => void
  onTtl: (next: string) => void
  onTrim: (next: string) => void
  onCancelRename: () => void
  onCancelTtl: () => void
  onCancelTrim: () => void
  hashEditor: ReturnType<typeof useHashEditor>
  listEditor: ReturnType<typeof useListEditor>
  setEditor: ReturnType<typeof useSetEditor>
  zsetEditor: ReturnType<typeof useZsetEditor>
  streamEditor: ReturnType<typeof useStreamEditor>
  /** list 统计（total 供弹窗底部状态栏） */
  listTotal: number
}

export function ValueDialogs({
  value,
  editVisible,
  onCloseEdit,
  renameVisible,
  ttlVisible,
  trimVisible,
  onRename,
  onTtl,
  onTrim,
  onCancelRename,
  onCancelTtl,
  onCancelTrim,
  hashEditor,
  listEditor,
  setEditor,
  zsetEditor,
  streamEditor,
  listTotal,
}: ValueDialogsProps) {
  const { t } = useI18n()
  return (
    <>
      {editVisible ? <EditValueDialog initial={value} onClose={onCloseEdit} /> : null}

      {hashEditor.editingField ? (
        <EditHashFieldDialog
          keyName={value.key}
          field={hashEditor.editingField.field}
          value={hashEditor.editingField.value}
          onClose={() => hashEditor.setEditingField(null)}
          onSaved={hashEditor.handleFieldSaved}
        />
      ) : null}

      {/* hash 新增字段弹窗（add 模式：HSET upsert，saved 走同一 handleFieldSaved） */}
      {hashEditor.addingField ? (
        <EditHashFieldDialog
          mode="add"
          keyName={value.key}
          onClose={() => hashEditor.setAddingField(false)}
          onSaved={hashEditor.handleFieldSaved}
        />
      ) : null}

      {hashEditor.ttlField ? (
        <EditHashFieldTtlDialog
          keyName={value.key}
          field={hashEditor.ttlField.field}
          currentTtl={hashEditor.ttlField.ttl}
          onClose={() => hashEditor.setTtlField(null)}
          onSaved={hashEditor.handleFieldTtlSaved}
        />
      ) : null}

      {/* stream entry 查看弹窗（只读：字段拆成键值对，长值换行不截断） */}
      {streamEditor.viewingStreamEntry ? (
        <ViewStreamEntryDialog
          keyName={value.key}
          entryId={streamEditor.viewingStreamEntry.entryId}
          fields={streamEditor.viewingStreamEntry.fields}
          position={streamEditor.viewingStreamEntry.position}
          total={streamEditor.streamStats.total}
          onClose={() => streamEditor.setViewingStreamEntry(null)}
        />
      ) : null}

      {/* stream 追加消息弹窗（XADD：ID 服务端自动生成） */}
      {streamEditor.addingEntry ? (
        <StreamAddEntryDialog
          keyName={value.key}
          total={streamEditor.streamStats.total}
          onConfirm={streamEditor.handleStreamAddConfirm}
          onCancel={() => streamEditor.setAddingEntry(false)}
        />
      ) : null}

      {/* zset 成员编辑弹窗（member + score 双字段） */}
      {zsetEditor.editingZset ? (
        <EditZsetMemberDialog
          mode="edit"
          keyName={value.key}
          total={zsetEditor.zsetStats.total}
          initialMember={zsetEditor.editingZset.member}
          initialScore={zsetEditor.editingZset.score}
          duplicatedScore
          onConfirm={zsetEditor.handleZsetConfirm}
          onCancel={() => zsetEditor.setEditingZset(null)}
        />
      ) : null}

      {/* zset 新增成员弹窗 */}
      {zsetEditor.addingZset ? (
        <EditZsetMemberDialog
          mode="add"
          keyName={value.key}
          total={zsetEditor.zsetStats.total}
          onConfirm={zsetEditor.handleAddZsetConfirm}
          onCancel={() => zsetEditor.setAddingZset(false)}
        />
      ) : null}

      {/* list 元素编辑弹窗（含底部状态栏统计） */}
      {listEditor.editingListIndex ? (
        <EditListElementDialog
          mode="edit"
          keyName={value.key}
          index={listEditor.editingListIndex.index}
          total={listTotal}
          initialValue={listEditor.editingListIndex.value}
          onConfirm={listEditor.handleListEditConfirm}
          onCancel={() => listEditor.setEditingListIndex(null)}
        />
      ) : null}

      {/* list 插入 / 追加元素弹窗（与修改弹窗同形态，仅操作不同） */}
      {listEditor.insertingList ? (
        <EditListElementDialog
          mode="insert"
          keyName={value.key}
          index={listEditor.insertingList.index}
          total={listTotal}
          position={listEditor.insertingList.position}
          appending={listEditor.insertingList.index >= listTotal}
          onConfirm={listEditor.handleListInsertConfirm}
          onCancel={() => listEditor.setInsertingList(null)}
        />
      ) : null}

      {/* set 成员编辑弹窗（无序集合：称「成员」且不显示位置） */}
      {setEditor.editingSetMember ? (
        <EditListElementDialog
          mode="edit"
          keyType="set"
          showPosition={false}
          keyName={value.key}
          index={0}
          total={setEditor.setStats.total}
          initialValue={setEditor.editingSetMember.value}
          onConfirm={setEditor.handleSetMemberConfirm}
          onCancel={() => setEditor.setEditingSetMember(null)}
        />
      ) : null}

      {/* set 新增成员弹窗 */}
      {setEditor.addingMember ? (
        <EditListElementDialog
          mode="insert"
          keyType="set"
          showPosition={false}
          keyName={value.key}
          index={0}
          total={setEditor.setStats.total}
          onConfirm={setEditor.handleAddMemberConfirm}
          onCancel={() => setEditor.setAddingMember(false)}
        />
      ) : null}

      {renameVisible ? (
        <PromptDialog
          title={t('common.renameKey')}
          label={t('common.newKeyName')}
          initialValue={value.key}
          hint={t('valueViewer.renamingMigratesKeysTtlWell')}
          confirmText={t('common.rename')}
          onConfirm={onRename}
          onCancel={onCancelRename}
        />
      ) : null}

      {ttlVisible ? (
        <PromptDialog
          title={t('common.setTtl')}
          label={t('keyBrowser.timeLive')}
          inputType="number"
          initialValue={value.ttl > 0 ? String(value.ttl) : ''}
          placeholder={t('keyBrowser.blank0MeansNoExpiration')}
          hint={t('keyBrowser.enter0LeaveBlankRemove')}
          confirmText={t('keyBrowser.apply')}
          presets={TTL_PRESETS.map((preset) => ({ ...preset, label: t(preset.label) }))}
          onConfirm={onTtl}
          onCancel={onCancelTtl}
        />
      ) : null}

      {trimVisible ? (
        <PromptDialog
          title={t('stream.trimTitle')}
          label={t('stream.trimValue')}
          initialValue=""
          placeholder="1000 / 1700000000000-0"
          hint={t('stream.trimHint')}
          confirmText={t('stream.trim')}
          onConfirm={onTrim}
          onCancel={onCancelTrim}
        />
      ) : null}
    </>
  )
}