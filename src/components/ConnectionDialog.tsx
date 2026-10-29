import { useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { useDialogDrag } from '@/hooks/useDialogDrag'
import { NoticeDrawer } from '@/components/NoticeDrawer'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useRedis } from '@/store/useRedis'
import type { RedisConnectionConfig, SshAuthMethod, SshHop } from '@shared/types'

const AUTH_OPTIONS: Array<{ value: SshAuthMethod; label: string }> = [
  { value: 'password', label: '密码' },
  { value: 'key', label: '私钥' },
]

/** SSH 表单的本地形态：所有字段必填（空串表未填），提交时再转回 SshConfig */
interface SshForm {
  host: string
  port: number
  username: string
  authMethod: SshAuthMethod
  password: string
  privateKey: string
  passphrase: string
  targetFromRemote: boolean
}

/** 中间跳板的本地形态：showPassword / showPassphrase 是纯界面状态，提交时丢弃 */
interface SshHopForm {
  host: string
  port: number
  username: string
  authMethod: SshAuthMethod
  password: string
  privateKey: string
  passphrase: string
  showPassword: boolean
  showPassphrase: boolean
}

function toHopForm(hop: SshHop): SshHopForm {
  return {
    host: hop.host ?? '',
    port: hop.port ?? 22,
    username: hop.username ?? 'root',
    authMethod: hop.authMethod ?? 'password',
    password: hop.password ?? '',
    privateKey: hop.privateKey ?? '',
    passphrase: hop.passphrase ?? '',
    showPassword: false,
    showPassphrase: false,
  }
}

export interface ConnectionDialogProps {
  initial?: RedisConnectionConfig | null
  onClose: () => void
}

/**
 * 新建 / 编辑连接弹窗（含 SSH 隧道与多级跳板）。
 *
 * 视觉层改用 shadcn 的基础组件（Dialog / Input / Label / Switch / Button /
 * Textarea，即 Cult UI 依赖的同一套原子组件），这些组件的样式全部由
 * `@/components/ui/*` 里的类名驱动，主题色经由 tailwind.css 的语义 token
 * 映射到本应用的 9 套皮肤上，因此换肤时会自动跟随。
 *
 * 交互约定保持不变：
 *   · 点击遮罩不关闭 —— 表单可能已填一半，误触外部导致全丢代价太高；
 *   · 标题栏可拖动窗口（Electron 下尤其需要）。
 */
export function ConnectionDialog({ initial, onClose }: ConnectionDialogProps) {
  const { connect, saveConnection, notify } = useRedis()
  const { style, onDragStart } = useDialogDrag()

  const isEdit = !!initial

  const [form, setForm] = useState<RedisConnectionConfig>({
    id: initial?.id ?? `conn-${Date.now().toString(36)}`,
    name: initial?.name ?? '',
    host: initial?.host ?? '127.0.0.1',
    port: initial?.port ?? 6379,
    username: initial?.username ?? '',
    password: initial?.password ?? '',
    db: initial?.db ?? 0,
    tls: initial?.tls ?? false,
  })

  function patchForm(patch: Partial<RedisConnectionConfig>): void {
    setForm((prev) => ({ ...prev, ...patch }))
  }

  /* ---------------------------------------------------------------- SSH 隧道 */

  /**
   * SSH 相关表单单独维护：它是连接的**可选扩展**，与 Redis 本身的主字段分开，
   * 提交时再拼进 payload。好处是关闭隧道时不必逐字段清空，重新开启还能恢复上次填的内容。
   */
  const [sshEnabled, setSshEnabled] = useState(initial?.sshEnabled ?? false)

  const [ssh, setSsh] = useState<SshForm>({
    host: initial?.ssh?.host ?? '',
    port: initial?.ssh?.port ?? 22,
    // 新建时默认 root（最常见跳板机账号）；编辑已有配置时保留原值
    username: initial?.ssh?.username ?? 'root',
    authMethod: initial?.ssh?.authMethod ?? 'password',
    password: initial?.ssh?.password ?? '',
    privateKey: initial?.ssh?.privateKey ?? '',
    passphrase: initial?.ssh?.passphrase ?? '',
    targetFromRemote: initial?.ssh?.targetFromRemote ?? true,
  })

  function patchSsh(patch: Partial<SshForm>): void {
    setSsh((prev) => ({ ...prev, ...patch }))
  }

  /* ------------------------------------------------ 中间跳板（多级） */

  const [hops, setHops] = useState<SshHopForm[]>((initial?.ssh?.hops ?? []).map(toHopForm))

  function patchHop(index: number, patch: Partial<SshHopForm>): void {
    setHops((prev) => prev.map((hop, i) => (i === index ? { ...hop, ...patch } : hop)))
  }

  function addHop(): void {
    setHops((prev) => [...prev, toHopForm({ host: '', port: 22, username: 'root', authMethod: 'password' })])
  }

  function removeHop(index: number): void {
    setHops((prev) => prev.filter((_, i) => i !== index))
  }

  /** 私钥内容从本地文件读入：避免用户手工复制几百行文本 */
  const keyInputRef = useRef<HTMLInputElement | null>(null)

  async function onKeyFileChange(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.target
    const file = input.files?.[0]
    input.value = '' // 允许重复选择同一文件
    if (!file) return
    try {
      patchSsh({ privateKey: await file.text() })
    } catch (error) {
      notify('err', error instanceof Error ? error.message : '读取私钥文件失败')
    }
  }

  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  /** 密码明文切换：默认密文，与浏览器/系统密码框的惯例一致 */
  const [showPassword, setShowPassword] = useState(false)
  const [showSshPassword, setShowSshPassword] = useState(false)
  const [showSshPassphrase, setShowSshPassphrase] = useState(false)

  /**
   * 提交前校验。
   *
   * SSH 开启后，校验范围随之扩大 —— 此时"连不通"最常见的原因是
   * 跳板机信息不全，而不是 Redis 本身有问题，所以要在前端先拦住。
   */
  const sshError = ((): string | null => {
    if (!sshEnabled) return null
    /*
     * 中间跳板先校验（与实际连接顺序一致）：
     * 多级链上哪一跳缺配置，报错直接点名序号。
     */
    for (let i = 0; i < hops.length; i += 1) {
      const hop = hops[i]!
      const label = hop.host.trim() ? `跳板 ${i + 1}（${hop.host.trim()}）` : `跳板 ${i + 1}`
      if (!hop.host.trim()) return `请填写${label}的地址`
      if (!hop.username.trim()) return `请填写${label}的用户名`
      if (!Number.isFinite(hop.port) || hop.port <= 0 || hop.port > 65535) return `${label}的端口无效`
      if (hop.authMethod === 'password' && !hop.password) return `请填写${label}的密码`
      if (hop.authMethod === 'key' && !hop.privateKey.trim()) return `请粘贴${label}的私钥内容`
    }
    if (!ssh.host.trim()) return '请填写 SSH 跳板机地址'
    if (!ssh.username.trim()) return '请填写 SSH 用户名'
    if (!Number.isFinite(ssh.port) || ssh.port <= 0 || ssh.port > 65535) return 'SSH 端口无效'
    if (ssh.authMethod === 'password' && !ssh.password) return '请填写 SSH 密码'
    if (ssh.authMethod === 'key' && !ssh.privateKey.trim()) return '请选择或粘贴私钥内容'
    return null
  })()

  const canSubmit = form.name.trim().length > 0 && form.host.trim().length > 0 && sshError === null

  function payload(): RedisConnectionConfig {
    /*
     * 中间跳板：完整填写才进 payload（校验已拦截空行），
     * 空数组归一为 undefined —— 主进程按"无 hops = 单级跳板"处理。
     */
    const hopList: SshHop[] = hops.map((hop) => ({
      host: hop.host.trim(),
      port: hop.port,
      username: hop.username.trim(),
      authMethod: hop.authMethod,
      password: hop.password || undefined,
      privateKey: hop.privateKey.trim() || undefined,
      passphrase: hop.passphrase || undefined,
    }))
    return {
      ...form,
      name: form.name.trim(),
      host: form.host.trim(),
      username: form.username?.trim() || undefined,
      password: form.password || undefined,
      /*
       * 关闭隧道时保留 ssh 配置但不置 sshEnabled，
       * 下次打开开关即可复用，不必重填 —— 但主进程不会使用它。
       */
      ssh: ssh.host.trim()
        ? { ...ssh, host: ssh.host.trim(), username: ssh.username.trim(), hops: hopList.length ? hopList : undefined }
        : undefined,
      sshEnabled,
      /*
       * 透传置顶状态：form 里没有 pinned 字段，不带上的话
       * 「改个名字保存」就会把已置顶的连接悄悄挤出顶部。
       */
      pinned: initial?.pinned,
    }
  }

  async function handleTest(): Promise<void> {
    if (sshError) {
      setTestResult({ ok: false, text: sshError })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await api.connection.test(payload())
      setTestResult(
        res.ok
          ? { ok: res.data.ok, text: res.data.message ?? (res.data.ok ? '连接成功' : '连接失败') }
          : { ok: false, text: res.error },
      )
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : '测试失败' })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave(andConnect: boolean): Promise<void> {
    if (!canSubmit) return
    setSaving(true)
    try {
      const saved = await saveConnection(payload())
      if (!saved) return
      if (andConnect) await connect(payload())
      onClose()
    } finally {
      setSaving(false)
    }
  }

  /** 认证方式的分段控件：两三个选项，用按钮组比下拉更省一次点击 */
  function AuthSegmented({
    value,
    onChange,
  }: {
    value: SshAuthMethod
    onChange: (next: SshAuthMethod) => void
  }) {
    return (
      <div className="seg" role="group" aria-label="认证方式">
        {AUTH_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`seg-item${value === option.value ? ' is-on' : ''}`}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // 遮罩点击 / Esc 交给 Radix 判定后统一走 onClose，避免两套关闭路径
        if (!next) onClose()
      }}
    >
      <DialogContent
        className="dialog dlg"
        style={style}
        showCloseButton={false}
        /*
         * 点击遮罩不关闭：表单可能已填一半，误触外部导致全丢代价太高。
         * Radix 的关闭判定挂在 pointerdown 上，必须用 onPointerDownOutside
         * 拦（onInteractOutside 在这里拦不住，实测遮罩点击仍会关闭）。
         * Esc 仍然有效 —— 键盘操作是有意为之，不算误触。
         */
        onPointerDownOutside={(event) => event.preventDefault()}
        // 自定义标题栏已接管语义标题，这里只补无障碍描述，避免控制台告警
        aria-describedby="dlg-desc"
      >
        <div className="dlg-shell">
          <header className="dlg-head" onMouseDown={onDragStart}>
            {/*
              图标与标题放进同一行（.dlg-head-top），由 flex 居中对齐 ——
              两者中心必然重合，不依赖字号/行高举算；副标题在下一行，
              用 padding-left 与标题文字左对齐（图标宽 30 + 间距 11）。
            */}
            <div className="dlg-head-main">
              <div className="dlg-head-top">
                <span className="dlg-head-icon">
                  <DialogIcon name={isEdit ? 'edit' : 'add'} size={15} />
                </span>
                <DialogTitle className="dlg-title">{isEdit ? '编辑连接' : '新建连接'}</DialogTitle>
              </div>
              <DialogDescription id="dlg-desc" className="dlg-sub">
                {isEdit ? '修改后保存即生效，已打开的会话需重连' : '填写 Redis 实例信息，可先测试再保存'}
              </DialogDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="dlg-close"
              aria-label="关闭"
              onClick={onClose}
            >
              <DialogIcon name="cancel" size={13} />
            </Button>
          </header>

          {/*
            测试结果抽屉的锚点。

            这一层高度恒为 0（.drawer-anchor），抽屉绝对定位从它垂落 ——
            所以通知出现 / 消失**不推动任何内容**：长表单不会跳，
            滚动条不会伸缩，没有页面抖动。

            为什么放在头部之后：抽屉顶部两角是直角、且 z-index 低于头部，
            从头部"后方"滑出；离场时原路缩回去。它挂在滚动区之前，
            因此表单滚多远都始终可见（这正是最初把它从内容末尾挪出来的原因）。

            key 绑结果文本：连续测两次时强制重挂载，动画与倒计时从头开始，
            避免"第二次结果复用了上次剩余时间、一闪就没"。
          */}
          <div className="drawer-anchor">
            {testResult ? (
              <NoticeDrawer
                key={`${testResult.ok}-${testResult.text}`}
                ok={testResult.ok}
                text={testResult.text}
                onDismiss={() => setTestResult(null)}
              />
            ) : null}
          </div>

          {/*
            凭据解密失败提示：本地凭据（密码/SSH 私钥口令）解密失败时，
            存储层会把凭据置空并把原因挂在 credentialError 上。
            只在连接失败时 toast 一次不够 —— 用户打开编辑框看到密码为空
            会误以为配置丢了；这里直接说明"是解密失败，请重新输入"。
          */}
          {initial?.credentialError ? (
            <div className="dlg-alert" role="status">
              <DialogIcon name="warning" size={14} />
              <span>{initial.credentialError}，保存后将重新加密存储。</span>
            </div>
          ) : null}

          <div className="dlg-body">
            {/* ------------------------------------------------ 基础信息 */}
            <section className="dlg-section">
              <h3 className="dlg-section-title">连接信息</h3>

              <div className="field">
                <Label htmlFor="conn-name" className="field-label">
                  连接名称
                  <span className="req" aria-hidden="true">
                    *
                  </span>
                </Label>
                <Input
                  id="conn-name"
                  value={form.name}
                  onChange={(event) => patchForm({ name: event.target.value })}
                  placeholder="例如：本地开发"
                  autoComplete="off"
                />
              </div>

              <div className="field-row">
                <div className="field grow">
                  <Label htmlFor="conn-host" className="field-label">
                    主机
                    <span className="req" aria-hidden="true">
                      *
                    </span>
                  </Label>
                  <Input
                    id="conn-host"
                    value={form.host}
                    onChange={(event) => patchForm({ host: event.target.value })}
                    className="mono"
                    placeholder="127.0.0.1"
                    autoComplete="off"
                  />
                </div>
                <div className="field port">
                  <Label htmlFor="conn-port" className="field-label">
                    端口
                  </Label>
                  <Input
                    id="conn-port"
                    value={form.port}
                    onChange={(event) => patchForm({ port: Number(event.target.value) })}
                    className="mono"
                    type="number"
                    min="1"
                    max="65535"
                  />
                </div>
              </div>

              <div className="field-row">
                <div className="field grow">
                  <Label htmlFor="conn-user" className="field-label">
                    用户名
                  </Label>
                  <Input
                    id="conn-user"
                    value={form.username ?? ''}
                    onChange={(event) => patchForm({ username: event.target.value })}
                    className="mono"
                    placeholder="Redis 6+ ACL，可留空"
                    autoComplete="off"
                  />
                </div>
                <div className="field grow">
                  <Label htmlFor="conn-pass" className="field-label">
                    密码
                  </Label>
                  <div className="input-with-action">
                    <Input
                      id="conn-pass"
                      value={form.password ?? ''}
                      onChange={(event) => patchForm({ password: event.target.value })}
                      className="mono"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="requirepass，可留空"
                      autoComplete="new-password"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="input-action"
                      aria-label={showPassword ? '隐藏密码' : '显示密码'}
                      onClick={() => setShowPassword((prev) => !prev)}
                    >
                      <DialogIcon name={showPassword ? 'eye-off' : 'eye'} size={13} />
                    </Button>
                  </div>
                </div>
              </div>

              <div className="field-row">
                <div className="field port">
                  <Label htmlFor="conn-db" className="field-label">
                    默认库
                  </Label>
                  {/*
                    默认库是固定枚举（Redis 默认 16 个库，0-15），
                    数字输入框要用户自己记住范围、还可能填越界；换成下拉
                    直接列出来，一次点击选定，也不会出现非法值。
                  */}
                  <Select
                    value={String(form.db)}
                    onValueChange={(next) => patchForm({ db: Number(next) })}
                  >
                    <SelectTrigger id="conn-db" className="dlg-select mono">
                      <SelectValue placeholder="选择库" />
                    </SelectTrigger>
                    <SelectContent className="dlg-select-menu">
                      {Array.from({ length: 16 }, (_, i) => (
                        <SelectItem key={i} value={String(i)} className="mono">
                          db{i}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>

            {/* ------------------------------------------------ SSH 隧道 */}
            <section className={`dlg-section ssh-block${sshEnabled ? ' is-on' : ''}`}>
              <div className="ssh-switch-row">
                <div className="ssh-switch-text">
                  <Label htmlFor="ssh-enabled" className="ssh-switch-title">
                    通过 SSH 隧道连接
                  </Label>
                  <p className="ssh-switch-sub">Redis 只在内网可达时，先登录跳板机再转发</p>
                </div>
                <Switch id="ssh-enabled" checked={sshEnabled} onCheckedChange={setSshEnabled} />
              </div>

              {sshEnabled ? (
                <div className="ssh-body">
                  <div className="field-row">
                    <div className="field grow">
                      <Label htmlFor="ssh-host" className="field-label">
                        跳板机地址
                        <span className="req" aria-hidden="true">
                          *
                        </span>
                      </Label>
                      <Input
                        id="ssh-host"
                        value={ssh.host}
                        onChange={(event) => patchSsh({ host: event.target.value })}
                        className="mono"
                        placeholder="例如：10.0.0.12 或 bastion.example.com"
                        autoComplete="off"
                      />
                    </div>
                    <div className="field port">
                      <Label htmlFor="ssh-port" className="field-label">
                        SSH 端口
                      </Label>
                      <Input
                        id="ssh-port"
                        value={ssh.port}
                        onChange={(event) => patchSsh({ port: Number(event.target.value) })}
                        className="mono"
                        type="number"
                        min="1"
                        max="65535"
                      />
                    </div>
                  </div>

                  <div className="field-row">
                    <div className="field grow">
                      <Label htmlFor="ssh-user" className="field-label">
                        SSH 用户名
                        <span className="req" aria-hidden="true">
                          *
                        </span>
                      </Label>
                      <Input
                        id="ssh-user"
                        value={ssh.username}
                        onChange={(event) => patchSsh({ username: event.target.value })}
                        className="mono"
                        placeholder="例如：root / ubuntu"
                        autoComplete="off"
                      />
                    </div>
                    <div className="field auth">
                      <span className="field-label">认证方式</span>
                      <AuthSegmented value={ssh.authMethod} onChange={(next) => patchSsh({ authMethod: next })} />
                    </div>
                  </div>

                  {ssh.authMethod === 'password' ? (
                    <div className="field">
                      <Label htmlFor="ssh-pass" className="field-label">
                        SSH 密码
                        <span className="req" aria-hidden="true">
                          *
                        </span>
                      </Label>
                      <div className="input-with-action">
                        <Input
                          id="ssh-pass"
                          value={ssh.password}
                          onChange={(event) => patchSsh({ password: event.target.value })}
                          className="mono"
                          type={showSshPassword ? 'text' : 'password'}
                          placeholder="跳板机登录密码"
                          autoComplete="new-password"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="input-action"
                          aria-label={showSshPassword ? '隐藏密码' : '显示密码'}
                          onClick={() => setShowSshPassword((prev) => !prev)}
                        >
                          <DialogIcon name={showSshPassword ? 'eye-off' : 'eye'} size={13} />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="field">
                        <div className="field-label key-label">
                          <span>
                            私钥内容
                            <span className="req" aria-hidden="true">
                              *
                            </span>
                          </span>
                          <button type="button" className="link-btn" onClick={() => keyInputRef.current?.click()}>
                            <DialogIcon name="folder-open" size={12} />
                            选择文件…
                          </button>
                          <input
                            ref={keyInputRef}
                            type="file"
                            className="hidden-file"
                            accept=".pem,.key,.ppk,.txt,*"
                            onChange={(event) => void onKeyFileChange(event)}
                          />
                        </div>
                        <Textarea
                          value={ssh.privateKey}
                          onChange={(event) => patchSsh({ privateKey: event.target.value })}
                          className="mono key-area"
                          rows={4}
                          spellCheck={false}
                          placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----'}
                        />
                      </div>
                      <div className="field">
                        <Label htmlFor="ssh-passphrase" className="field-label">
                          私钥口令
                        </Label>
                        <div className="input-with-action">
                          <Input
                            id="ssh-passphrase"
                            value={ssh.passphrase}
                            onChange={(event) => patchSsh({ passphrase: event.target.value })}
                            className="mono"
                            type={showSshPassphrase ? 'text' : 'password'}
                            placeholder="私钥未加密可留空"
                            autoComplete="new-password"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="input-action"
                            aria-label={showSshPassphrase ? '隐藏口令' : '显示口令'}
                            onClick={() => setShowSshPassphrase((prev) => !prev)}
                          >
                            <DialogIcon name={showSshPassphrase ? 'eye-off' : 'eye'} size={13} />
                          </Button>
                        </div>
                      </div>
                    </>
                  )}

                  {/* ---------------------------------------- 中间跳板（多级，可选） */}
                  <div className="hops-block">
                    <div className="hops-head">
                      <span className="hops-title">中间跳板</span>
                      <button type="button" className="link-btn" onClick={addHop}>
                        <DialogIcon name="add" size={12} />
                        添加跳板机
                      </button>
                    </div>
                    {!hops.length ? (
                      <p className="ssh-hint">
                        Redis 需经多台机器接力可达时，按登录顺序添加：本机 → 跳板 1 → … → 上方跳板机 → Redis。
                      </p>
                    ) : null}
                    {hops.map((hop, index) => (
                      <div key={index} className="hop-card">
                        <div className="hop-head">
                          <span className="hop-badge">跳板 {index + 1}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="hop-del"
                            aria-label={`删除跳板 ${index + 1}`}
                            onClick={() => removeHop(index)}
                          >
                            <DialogIcon name="trash" size={12} />
                          </Button>
                        </div>
                        <div className="field-row">
                          <div className="field grow">
                            <Label className="field-label">
                              地址
                              <span className="req" aria-hidden="true">
                                *
                              </span>
                            </Label>
                            <Input
                              value={hop.host}
                              onChange={(event) => patchHop(index, { host: event.target.value })}
                              className="mono"
                              placeholder="例如：10.0.0.11"
                              autoComplete="off"
                            />
                          </div>
                          <div className="field port">
                            <Label className="field-label">SSH 端口</Label>
                            <Input
                              value={hop.port}
                              onChange={(event) => patchHop(index, { port: Number(event.target.value) })}
                              className="mono"
                              type="number"
                              min="1"
                              max="65535"
                            />
                          </div>
                        </div>
                        <div className="field-row">
                          <div className="field grow">
                            <Label className="field-label">
                              用户名
                              <span className="req" aria-hidden="true">
                                *
                              </span>
                            </Label>
                            <Input
                              value={hop.username}
                              onChange={(event) => patchHop(index, { username: event.target.value })}
                              className="mono"
                              placeholder="例如：root / ubuntu"
                              autoComplete="off"
                            />
                          </div>
                          <div className="field auth">
                            <span className="field-label">认证方式</span>
                            <AuthSegmented
                              value={hop.authMethod}
                              onChange={(next) => patchHop(index, { authMethod: next })}
                            />
                          </div>
                        </div>
                        {hop.authMethod === 'password' ? (
                          <div className="field">
                            <Label className="field-label">
                              密码
                              <span className="req" aria-hidden="true">
                                *
                              </span>
                            </Label>
                            <div className="input-with-action">
                              <Input
                                value={hop.password}
                                onChange={(event) => patchHop(index, { password: event.target.value })}
                                className="mono"
                                type={hop.showPassword ? 'text' : 'password'}
                                placeholder="此跳板的登录密码"
                                autoComplete="new-password"
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="input-action"
                                aria-label={hop.showPassword ? '隐藏密码' : '显示密码'}
                                onClick={() => patchHop(index, { showPassword: !hop.showPassword })}
                              >
                                <DialogIcon name={hop.showPassword ? 'eye-off' : 'eye'} size={13} />
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="field">
                              <Label className="field-label">
                                私钥内容
                                <span className="req" aria-hidden="true">
                                  *
                                </span>
                              </Label>
                              <Textarea
                                value={hop.privateKey}
                                onChange={(event) => patchHop(index, { privateKey: event.target.value })}
                                className="mono key-area"
                                rows={3}
                                spellCheck={false}
                                placeholder="粘贴此跳板的私钥（-----BEGIN OPENSSH PRIVATE KEY-----…）"
                              />
                            </div>
                            <div className="field">
                              <Label className="field-label">私钥口令</Label>
                              <div className="input-with-action">
                                <Input
                                  value={hop.passphrase}
                                  onChange={(event) => patchHop(index, { passphrase: event.target.value })}
                                  className="mono"
                                  type={hop.showPassphrase ? 'text' : 'password'}
                                  placeholder="私钥未加密可留空"
                                  autoComplete="new-password"
                                />
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="input-action"
                                  aria-label={hop.showPassphrase ? '隐藏口令' : '显示口令'}
                                  onClick={() => patchHop(index, { showPassphrase: !hop.showPassphrase })}
                                >
                                  <DialogIcon name={hop.showPassphrase ? 'eye-off' : 'eye'} size={13} />
                                </Button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>

                  {sshError ? (
                    <p className="ssh-error">{sshError}</p>
                  ) : (
                    <p className="ssh-hint">隧道在连接时建立，断开连接后自动关闭；Redis 地址按跳板机视角填写。</p>
                  )}
                </div>
              ) : null}
            </section>

          </div>

          <footer className="dlg-foot">
            <Button
              type="button"
              variant="outline"
              className="foot-btn"
              disabled={testing || !canSubmit}
              onClick={() => void handleTest()}
            >
              <DialogIcon name="test" size={13} />
              {testing ? '测试中…' : '测试连接'}
            </Button>
            <span className="spacer" />
            <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onClose}>
              {/* 与「测试连接 / 仅保存 / 保存并连接」保持一致：每个按钮都带图标，
                  只有纯文字会让这一颗在视觉上轻一档，也容易被误读成"链接" */}
              <DialogIcon name="cancel" size={13} />
              取消
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="foot-btn"
              disabled={saving || !canSubmit}
              onClick={() => void handleSave(false)}
            >
              <DialogIcon name="save" size={13} />
              仅保存
            </Button>
            <Button
              type="button"
              className="foot-btn foot-primary"
              disabled={saving || !canSubmit}
              onClick={() => void handleSave(true)}
            >
              <DialogIcon name="save" size={13} />
              保存并连接
            </Button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default ConnectionDialog
