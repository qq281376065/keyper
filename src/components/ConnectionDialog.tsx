import { useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { useDialogDrag } from '@/hooks/useDialogDrag'
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
 * 点击遮罩不关闭：表单可能已填了一半，误触外部导致全部丢失的代价
 * 远高于多点一次关闭按钮。
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

  return (
    <div className="mask s-connection-dialog">
      <div className="dialog" style={style}>
        <header className="dialog-head" onMouseDown={onDragStart}>
          <span>{isEdit ? '编辑连接' : '新建连接'}</span>
          <button className="btn-ghost tiny" onClick={onClose}>
            <DialogIcon name="cancel" size={12} />
          </button>
        </header>

        {/*
          凭据解密失败黄条：本地凭据（密码/SSH 私钥口令）解密失败时，
          存储层会把凭据置空并把原因挂在 credentialError 上。
          只在连接失败时 toast 一次不够 —— 用户打开编辑框看到密码为空
          会误以为配置丢了；黄条直接说明"是解密失败，请重新输入"。
        */}
        {initial?.credentialError ? (
          <div className="credential-warning">
            <DialogIcon name="warning" size={14} />
            <span>{initial.credentialError}，保存后将重新加密存储。</span>
          </div>
        ) : null}

        <div className="dialog-body">
          <label className="field">
            <span className="label">
              连接名称 <i>*</i>
            </span>
            <span className="input-wrap">
              <input
                value={form.name}
                onChange={(event) => patchForm({ name: event.target.value })}
                placeholder="例如：本地开发"
              />
              {form.name ? (
                <button type="button" className="input-icon" title="清空" onClick={() => patchForm({ name: '' })}>
                  <DialogIcon name="cancel" size={11} />
                </button>
              ) : null}
            </span>
          </label>

          <div className="field-row">
            <label className="field grow">
              <span className="label">
                主机 <i>*</i>
              </span>
              <span className="input-wrap">
                <input
                  value={form.host}
                  onChange={(event) => patchForm({ host: event.target.value })}
                  className="mono"
                  placeholder="127.0.0.1"
                />
                {form.host ? (
                  <button type="button" className="input-icon" title="清空" onClick={() => patchForm({ host: '' })}>
                    <DialogIcon name="cancel" size={11} />
                  </button>
                ) : null}
              </span>
            </label>
            <label className="field port">
              <span className="label">端口</span>
              <input
                value={form.port}
                onChange={(event) => patchForm({ port: Number(event.target.value) })}
                className="mono"
                type="number"
                min="1"
                max="65535"
              />
            </label>
          </div>

          <div className="field-row">
            <label className="field grow">
              <span className="label">用户名</span>
              <input
                value={form.username ?? ''}
                onChange={(event) => patchForm({ username: event.target.value })}
                className="mono"
                placeholder="Redis 6+ ACL，可留空"
              />
            </label>
            <label className="field grow">
              <span className="label">密码</span>
              <span className="input-wrap">
                <input
                  value={form.password ?? ''}
                  onChange={(event) => patchForm({ password: event.target.value })}
                  className="mono"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="requirepass，可留空"
                />
                <button
                  type="button"
                  className="input-icon"
                  title={showPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => setShowPassword((prev) => !prev)}
                >
                  <DialogIcon name={showPassword ? 'eye-off' : 'eye'} size={13} />
                </button>
              </span>
            </label>
          </div>

          <div className="field-row">
            <label className="field port">
              <span className="label">默认库</span>
              <input
                value={form.db}
                onChange={(event) => patchForm({ db: Number(event.target.value) })}
                className="mono"
                type="number"
                min="0"
                max="15"
              />
            </label>
          </div>

          {/* ------------------------------------------------ SSH 隧道 */}
          <div className={`ssh-section${sshEnabled ? ' on' : ''}`}>
            <label className="ssh-toggle">
              <input
                type="checkbox"
                className="switch"
                checked={sshEnabled}
                onChange={(event) => setSshEnabled(event.target.checked)}
              />
              <span className="ssh-title">通过 SSH 隧道连接</span>
              <span className="ssh-sub">Redis 只在内网可达时，先登录跳板机再转发</span>
            </label>

            {sshEnabled ? (
              <div className="ssh-body">
                <div className="field-row">
                  <label className="field grow">
                    <span className="label">
                      跳板机地址 <i>*</i>
                    </span>
                    <input
                      value={ssh.host}
                      onChange={(event) => patchSsh({ host: event.target.value })}
                      className="mono"
                      placeholder="例如：10.0.0.12 或 bastion.example.com"
                    />
                  </label>
                  <label className="field port">
                    <span className="label">SSH 端口</span>
                    <input
                      value={ssh.port}
                      onChange={(event) => patchSsh({ port: Number(event.target.value) })}
                      className="mono"
                      type="number"
                      min="1"
                      max="65535"
                    />
                  </label>
                </div>

                <div className="field-row">
                  <label className="field grow">
                    <span className="label">
                      SSH 用户名 <i>*</i>
                    </span>
                    <input
                      value={ssh.username}
                      onChange={(event) => patchSsh({ username: event.target.value })}
                      className="mono"
                      placeholder="例如：root / ubuntu"
                    />
                  </label>
                  <div className="field auth">
                    <span className="label">认证方式</span>
                    <div className="segmented">
                      {AUTH_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={ssh.authMethod === option.value ? 'active' : ''}
                          onClick={() => patchSsh({ authMethod: option.value })}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {ssh.authMethod === 'password' ? (
                  <label className="field">
                    <span className="label">
                      SSH 密码 <i>*</i>
                    </span>
                    <span className="input-wrap">
                      <input
                        value={ssh.password}
                        onChange={(event) => patchSsh({ password: event.target.value })}
                        className="mono"
                        type={showSshPassword ? 'text' : 'password'}
                        placeholder="跳板机登录密码"
                      />
                      <button
                        type="button"
                        className="input-icon"
                        title={showSshPassword ? '隐藏密码' : '显示密码'}
                        onClick={() => setShowSshPassword((prev) => !prev)}
                      >
                        <DialogIcon name={showSshPassword ? 'eye-off' : 'eye'} size={13} />
                      </button>
                    </span>
                  </label>
                ) : (
                  <>
                    <div className="field">
                      <span className="label key-label">
                        私钥内容 <i>*</i>
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
                      </span>
                      <textarea
                        value={ssh.privateKey}
                        onChange={(event) => patchSsh({ privateKey: event.target.value })}
                        className="mono key-area"
                        rows={4}
                        spellCheck={false}
                        placeholder='-----BEGIN OPENSSH PRIVATE KEY-----
…
-----END OPENSSH PRIVATE KEY-----'
                      />
                    </div>
                    <label className="field">
                      <span className="label">私钥口令</span>
                      <span className="input-wrap">
                        <input
                          value={ssh.passphrase}
                          onChange={(event) => patchSsh({ passphrase: event.target.value })}
                          className="mono"
                          type={showSshPassphrase ? 'text' : 'password'}
                          placeholder="私钥未加密可留空"
                        />
                        <button
                          type="button"
                          className="input-icon"
                          title={showSshPassphrase ? '隐藏口令' : '显示口令'}
                          onClick={() => setShowSshPassphrase((prev) => !prev)}
                        >
                          <DialogIcon name={showSshPassphrase ? 'eye-off' : 'eye'} size={13} />
                        </button>
                      </span>
                    </label>
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
                        <button
                          type="button"
                          className="btn-ghost tiny hop-del"
                          title={`删除跳板 ${index + 1}`}
                          onClick={() => removeHop(index)}
                        >
                          <DialogIcon name="trash" size={12} />
                        </button>
                      </div>
                      <div className="field-row">
                        <label className="field grow">
                          <span className="label">
                            地址 <i>*</i>
                          </span>
                          <input
                            value={hop.host}
                            onChange={(event) => patchHop(index, { host: event.target.value })}
                            className="mono"
                            placeholder="例如：10.0.0.11"
                          />
                        </label>
                        <label className="field port">
                          <span className="label">SSH 端口</span>
                          <input
                            value={hop.port}
                            onChange={(event) => patchHop(index, { port: Number(event.target.value) })}
                            className="mono"
                            type="number"
                            min="1"
                            max="65535"
                          />
                        </label>
                      </div>
                      <div className="field-row">
                        <label className="field grow">
                          <span className="label">
                            用户名 <i>*</i>
                          </span>
                          <input
                            value={hop.username}
                            onChange={(event) => patchHop(index, { username: event.target.value })}
                            className="mono"
                            placeholder="例如：root / ubuntu"
                          />
                        </label>
                        <div className="field auth">
                          <span className="label">认证方式</span>
                          <div className="segmented">
                            {AUTH_OPTIONS.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                className={hop.authMethod === option.value ? 'active' : ''}
                                onClick={() => patchHop(index, { authMethod: option.value })}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      {hop.authMethod === 'password' ? (
                        <label className="field">
                          <span className="label">
                            密码 <i>*</i>
                          </span>
                          <span className="input-wrap">
                            <input
                              value={hop.password}
                              onChange={(event) => patchHop(index, { password: event.target.value })}
                              className="mono"
                              type={hop.showPassword ? 'text' : 'password'}
                              placeholder="此跳板的登录密码"
                            />
                            <button
                              type="button"
                              className="input-icon"
                              title={hop.showPassword ? '隐藏密码' : '显示密码'}
                              onClick={() => patchHop(index, { showPassword: !hop.showPassword })}
                            >
                              <DialogIcon name={hop.showPassword ? 'eye-off' : 'eye'} size={13} />
                            </button>
                          </span>
                        </label>
                      ) : (
                        <>
                          <label className="field">
                            <span className="label">
                              私钥内容 <i>*</i>
                            </span>
                            <textarea
                              value={hop.privateKey}
                              onChange={(event) => patchHop(index, { privateKey: event.target.value })}
                              className="mono key-area"
                              rows={3}
                              spellCheck={false}
                              placeholder="粘贴此跳板的私钥（-----BEGIN OPENSSH PRIVATE KEY-----…）"
                            />
                          </label>
                          <label className="field">
                            <span className="label">私钥口令</span>
                            <span className="input-wrap">
                              <input
                                value={hop.passphrase}
                                onChange={(event) => patchHop(index, { passphrase: event.target.value })}
                                className="mono"
                                type={hop.showPassphrase ? 'text' : 'password'}
                                placeholder="私钥未加密可留空"
                              />
                              <button
                                type="button"
                                className="input-icon"
                                title={hop.showPassphrase ? '隐藏口令' : '显示口令'}
                                onClick={() => patchHop(index, { showPassphrase: !hop.showPassphrase })}
                              >
                                <DialogIcon name={hop.showPassphrase ? 'eye-off' : 'eye'} size={13} />
                              </button>
                            </span>
                          </label>
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
          </div>

          {testResult ? <p className={`test-result${testResult.ok ? ' ok' : ''}`}>{testResult.text}</p> : null}
        </div>

        <footer className="dialog-foot">
          <button className="btn" disabled={testing || !canSubmit} onClick={() => void handleTest()}>
            <DialogIcon name="test" />
            {testing ? '测试中…' : '测试连接'}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            <DialogIcon name="cancel" />
            取消
          </button>
          <button className="btn" disabled={saving || !canSubmit} onClick={() => void handleSave(false)}>
            <DialogIcon name="save" />
            仅保存
          </button>
          <button className="btn-primary btn" disabled={saving || !canSubmit} onClick={() => void handleSave(true)}>
            <DialogIcon name="save" />
            保存并连接
          </button>
        </footer>
      </div>
    </div>
  )
}

export default ConnectionDialog
