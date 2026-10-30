import { createServer, type Server, type Socket } from 'node:net'
import { Client, type ConnectConfig, type ClientChannel } from 'ssh2'
import { t } from '@shared/i18n'
import type { MemcachedConnectionConfig, RedisConnectionConfig, SshConfig, SshHop } from '../../shared/types'

/**
 * SSH 隧道（本地端口转发）。
 *
 * 工作方式：
 *   1. 建立到跳板机的 SSH 连接
 *   2. 在本机 127.0.0.1 上监听一个随机空闲端口
 *   3. 每来一个本地连接，请求 SSH 打开一条通往 `目标:端口` 的 direct-tcpip 通道
 *   4. 双向 pipe 起来
 *
 * 这样 ioredis 只要连 `127.0.0.1:<本地端口>`，无需感知 SSH 的存在。
 *
 * 为什么不直接用 `forwardOut` 单条通道：
 * ioredis 会自己发起连接（含重连），无法把一个已建立的 socket 塞给它；
 * 本地监听端口是唯一能让上层保持"普通 TCP"语义的做法。
 */

/** 一条活跃的隧道 */
export interface Tunnel {
  server: Server
  client: Client
  /**
   * 中间跳板链的 SSH 客户端（按连接顺序）。
   * 断链时必须自外向内全部结束，否则边界机会话残留。
   * 单级跳板时为空数组。
   */
  hopClients: Client[]
  /** ioredis 应连接的本地端口 */
  localPort: number
  /** 已建立的本地 socket，用于隧道关闭时统一销毁 */
  sockets: Set<Socket>
  /**
   * 配置指纹（不含凭据）：host|port|username|authMethod|hops。
   * 用于「配置没变就复用现有隧道」的判断。
   */
  key: string
  /**
   * SSH 连接是否仍然存活。
   *
   * ssh2 断开（keepalive 失败 / 跳板机踢人 / 网络抖动）时置 false。
   * 若不跟踪，ensure 会把一条死隧道当可复用交出去 ——
   * 本地 server 还在监听，ioredis 能建立 TCP，
   * 但每次 forwardOut 都抛 "Connection is closed."，
   * 错误信息与「SSH 配置是否正确」毫无关系，极难排查。
   */
  alive: boolean
}

/** 空闲端口：操作系统分配，避免端口冲突 */
const LOOPBACK = '127.0.0.1'

/** 生成隧道配置指纹：凭据变化不影响指纹（密码重填不需要重建隧道结构判断） */
function tunnelKey(ssh: SshConfig): string {
  const hops = (ssh.hops ?? [])
    .map((hop) => `${hop.host.trim()}:${hop.port}`)
    .join('>')
  return [ssh.host.trim(), ssh.port, ssh.username.trim(), ssh.authMethod, hops].join('|')
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 校验 SSH 配置是否完整。
 *
 * 提前校验而不是等 ssh2 抛错：ssh2 的错误信息偏底层
 * （如 "Cannot parse privateKey"），对用户不够直观。
 */
export function validateSshConfig(ssh: SshConfig): string | null {
  /*
   * 中间跳板先校验（与实际连接顺序一致），报错带序号 ——
   * 多级链上哪一跳缺配置一目了然，不必逐台排查。
   */
  const hopList = ssh.hops ?? []
  for (let i = 0; i < hopList.length; i += 1) {
    const hop = hopList[i]
    const index = i + 1
    const host = hop.host?.trim() ?? ''
    if (!host) return t('sshTunnel.jumpHostAddressRequired', { index })
    if (!hop.username?.trim()) {
      return t('sshTunnel.jumpHostUsernameRequired', { index, host })
    }
    if (!Number.isFinite(hop.port) || hop.port <= 0 || hop.port > 65535) {
      return t('sshTunnel.jumpHostPortInvalid', { index, host })
    }
    if (hop.authMethod === 'password' && !hop.password) {
      return t('sshTunnel.jumpHostPasswordRequired', { index, host })
    }
    if (hop.authMethod === 'key' && !hop.privateKey?.trim()) {
      return t('sshTunnel.jumpHostPrivateKeyRequired', { index, host })
    }
  }
  if (!ssh.host?.trim()) return t('sshTunnel.sshBastionAddressCannotEmpty')
  if (!ssh.username?.trim()) return t('sshTunnel.sshUsernameCannotEmpty')
  if (!Number.isFinite(ssh.port) || ssh.port <= 0 || ssh.port > 65535) {
    return t('connectionDialog.invalidSshPort')
  }
  if (ssh.authMethod === 'password' && !ssh.password) {
    return t('sshTunnel.passwordAuthenticationRequiresSsh')
  }
  if (ssh.authMethod === 'key' && !ssh.privateKey?.trim()) {
    return t('sshTunnel.privateKeyAuthenticationRequires')
  }
  return null
}

/** 组装 ssh2 的连接参数 */
function buildSshConnectConfig(ssh: SshConfig): ConnectConfig {
  const base: ConnectConfig = {
    host: ssh.host.trim(),
    port: ssh.port,
    username: ssh.username.trim(),
    // 允许首次连接的未知主机（不弹指纹确认）：桌面应用里没有交互式确认界面，
    // 直接拒绝会让用户无从下手。安全性由"不自动信任后续变更"之外的场景提示弥补。
    readyTimeout: 20000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    /*
     * 密码认证时开启 keyboard-interactive：部分服务端只接受该方式，
     * 关掉会报 "All configured authentication methods failed"。
     * 挑战应答在 connectOne 里通过同名事件回填密码。
     */
    tryKeyboard: ssh.authMethod === 'password' && !!ssh.password,
  }

  if (ssh.authMethod === 'key') {
    return {
      ...base,
      privateKey: ssh.privateKey,
      passphrase: ssh.passphrase || undefined,
    }
  }

  return { ...base, password: ssh.password }
}

/**
 * 建立一条 SSH 连接（可指定底层流 —— 多级跳板时传入上一跳的 forwardOut 通道）。
 *
 * hop 形参与 SshConfig/SshHop 结构兼容（只用认证相关字段），
 * 这样单级最后一跳与中间跳板共用同一套认证/兜底逻辑。
 */
function connectOne(
  hop: Pick<SshConfig, 'host' | 'port' | 'username' | 'authMethod' | 'password' | 'privateKey' | 'passphrase'>,
  /*
   * 上一跳 forwardOut 出的通道；缺省表示从本机直连。
   * 类型是 ClientChannel（ssh2 的流）而非 net.Socket ——
   * ssh2 的 connect 只要求一个 Duplex，两类流对它等价。
   */
  sock?: ClientChannel,
  label = t('sshTunnel.loginFailed'),
): Promise<Client> {
  const client = new Client()
  const t0 = Date.now()

  /*
   * keyboard-interactive 兜底：不少跳板机（尤其云厂商加固镜像）只开
   * keyboard-interactive 认证、关掉 password。ssh2 在 tryKeyboard:false 时
   * 不会宣告该能力，服务端把仅剩的 password 也拒掉，最终报
   * "All configured authentication methods failed" —— 用户配置完全正确却连不上。
   * 这里宣告支持，并在收到挑战时用同一份密码应答。
   */
  if (hop.authMethod === 'password' && hop.password) {
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      // 每个提示都按密码回答；无提示时交空数组保持握手继续
      finish(prompts.map(() => hop.password ?? ''))
    })
  }

  return new Promise<Client>((resolve, reject) => {
    // 只监听一次：ssh2 的 'error' 与 'ready' 可能先后触发，用 settled 防止重复 resolve
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      client.removeAllListeners()
      client.end()
      reject(new Error(message))
    }

    client.once('ready', () => {
      if (settled) return
      settled = true
      if (process.env.KEYPER_DEBUG || process.env.REDISDOCTER_DEBUG) {
        console.log(`[ssh] ${hop.host.trim()}:${hop.port} 握手+认证 ${Date.now() - t0}ms`)
      }
      resolve(client)
    })
    client.once('error', (error) => fail(t('sshTunnel.labelWithError', { label, error: toMessage(error) })))
    client.once('timeout', () => fail(t('sshTunnel.label', { label })))

    try {
      const config = buildSshConnectConfig(hop)
      client.connect(sock ? { ...config, sock } : config)
    } catch (error) {
      fail(t('sshTunnel.labelWithError', { label, error: toMessage(error) }))
    }
  })
}

/**
 * 在上一跳上打开通往下一跳的 TCP 通道（ssh2 的 direct-tcpip）。
 *
 * label 由调用方给出（如 "无法到达跳板 2（10.0.0.2）"）：
 * 序号必须按 1 起始的全链顺序编号，与界面行号一致，
 * 否则报错指向错误的机器，排查方向直接跑偏。
 */
function hopStream(
  prev: Client,
  target: Pick<SshHop, 'host' | 'port'>,
  label: string,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    try {
      prev.forwardOut(LOOPBACK, 0, target.host.trim(), target.port, (error, channel) => {
        if (error) reject(new Error(t('sshTunnel.labelWithError', { label, error: toMessage(error) })))
        else resolve(channel)
      })
    } catch (error) {
      reject(new Error(t('sshTunnel.labelWithError', { label, error: toMessage(error) })))
    }
  })
}

/**
 * 隧道只关心"连到哪、经哪台跳板"，与上层是 Redis 还是 Memcached 无关。
 * 两种连接配置在 host/port/id/ssh 上结构一致，因此共用一个入参类型。
 */
export type TunnelTarget = RedisConnectionConfig | MemcachedConnectionConfig

/**
 * 打开一条隧道。
 *
 * @param config   完整的连接配置（含 ssh 字段）
 * @returns 本地监听端口
 * @throws  配置无效 / SSH 登录失败 / 端口转发失败
 */
export async function openTunnel(config: TunnelTarget): Promise<Tunnel> {
  const ssh = config.ssh
  if (!ssh) throw new Error(t('sshTunnel.missingSshConfiguration'))
  const tOpen = Date.now()

  const invalid = validateSshConfig(ssh)
  if (invalid) throw new Error(invalid)

  /*
   * 多级跳板：按顺序建立「本机 → hop1 → hop2 → … → 最后一跳」。
   * 每一级在前一级的 SSH 会话上 forwardOut 出 TCP 通道，
   * 作为下一级 ssh2 connect 的底层流（sock）。
   * 任一跳失败：已建立的连接自外向内全部回收，不留半条链。
   */
  const hopClients: Client[] = []
  const hops = ssh.hops ?? []
  let client: Client

  /*
   * 本地监听与 SSH 握手并行。
   *
   * 原来顺序是「握手 → createServer → listen → 返回端口」，
   * 后两段（createServer + listen）虽只有几毫秒，但整个隧道必须全部
   * 就绪后 connection-manager 才敢去连 Redis —— 于是"SSH 1.2s + 监听 5ms"
   * 与"SSH 1.2s ∥ 监听 5ms"差不出多少。
   * 真正省时间的是把**监听先起好**，让 Redis 的 TCP 连接在 SSH 就绪前
   * 就能排进 backlog（connect 会立即成功，命令等隧道通了再走）。
   *
   * 因此这里先建 server 并 listen（拿到 port），再去做握手；
   * 握手失败时统一 close server，不会泄漏端口。
   */
  const sockets = new Set<Socket>()
  let liveClient: Client | null = null

  const server = createServer((local: Socket) => {
    sockets.add(local)
    local.on('close', () => sockets.delete(local))

    const active = liveClient
    if (!active) {
      /* 隧道尚未就绪（或已断）：直接拒绝，让 ioredis 走重试 */
      local.destroy()
      return
    }

    try {
      active.forwardOut(
        LOOPBACK,
        local.remotePort ?? 0,
        config.host,
        config.port,
        (error, channel: ClientChannel) => {
          if (error) {
            local.destroy()
            return
          }
          local.on('error', () => channel.destroy())
          channel.on('error', () => local.destroy())
          local.pipe(channel).pipe(local)
        },
      )
    } catch {
      local.destroy()
    }
  })

  const earlyPort = await new Promise<number>((resolve, reject) => {
    server.once('error', (error) =>
      reject(new Error(t('sshTunnel.failedListenLocalPort', { error: toMessage(error) }))),
    )
    server.listen(0, LOOPBACK, () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error(t('sshTunnel.notGetLocalListeningPort')))
    })
  })

  try {
    for (let i = 0; i < hops.length; i += 1) {
      const hop = hops[i]
      // 第一跳从本机直连；后续跳板在前一跳的 forwardOut 通道上建立
      const sock =
        i === 0
          ? undefined
          : await hopStream(
              hopClients[i - 1],
              hop,
              t('sshTunnel.cannotReachJumpHostIndex', { index: i + 1, host: hop.host.trim() }),
            )
      hopClients.push(
        await connectOne(
          hop,
          sock,
          t('sshTunnel.loginFailedViaJumpHost', { index: i + 1, host: hop.host.trim() }),
        ),
      )
    }

    // 最后一跳（ssh 本体）：有中间跳板时在最后一个跳板的通道上连接
    const finalSock =
      hopClients.length > 0
        ? await hopStream(
            hopClients[hopClients.length - 1],
            ssh,
            t('sshTunnel.cannotReachFinalHop', { host: ssh.host.trim() }),
          )
        : undefined
    client = await connectOne(ssh, finalSock)
  } catch (error) {
    for (const hopClient of hopClients) {
      try {
        hopClient.end()
      } catch {
        /* 已断开的跳板不需要处理 */
      }
    }
    /*
     * 关闭提前启动的本地 server：握手失败时它已在监听，
     * 不关就泄漏一个端口和一个空 server（每次连接失败漏一个，
     * 反复重试会累积）。这是"监听提前"带来的新责任。
     */
    for (const socket of sockets) {
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
    }
    sockets.clear()
    try {
      server.close()
    } catch {
      /* 未开始监听时 close 会抛错，忽略 */
    }
    throw error
  }

  /*
   * 目标地址：默认以跳板机视角解析（Redis 在内网）。
   * 若用户显式关掉 targetFromRemote，则先在本机解析再交给 SSH ——
   * 这种场景少见（Redis 可从本机访问，只想借 SSH 加密），
   * 但保留开关，避免"必须改 Redis 地址"的硬编码假设。
   */
  const targetHost = config.host
  const targetPort = config.port

  /*
   * 握手已成功：把 client 交给提前建好的 server（见上方说明），
   * 之后所有本地连接都会转发到它。
   */
  liveClient = client
  const localPort = earlyPort

  const tunnel: Tunnel = {
    server,
    client,
    hopClients,
    localPort,
    sockets,
    key: tunnelKey(ssh),
    alive: true,
  }

  /*
   * SSH 断开后必须立刻关闭本地 server：
   * 不关的话 server 变僵尸 —— ioredis 重连能建立 TCP（本地在听），
   * 但每条命令都在 forwardOut 处同步抛 "Connection is closed."。
   * 关掉 server 让 ioredis 拿到 ECONNREFUSED，触发干净的重试/报错。
   */
  client.on('close', () => {
    tunnel.alive = false
    for (const socket of sockets) {
      try {
        socket.destroy()
      } catch {
        // 已销毁的连接不需要额外处理
      }
    }
    sockets.clear()
    try {
      server.close()
    } catch {
      // server 未开始监听时 close 会抛错，忽略
    }
  })

  if (process.env.KEYPER_DEBUG || process.env.REDISDOCTER_DEBUG) {
    console.log(
      `[ssh] 隧道就绪 总耗时 ${Date.now() - tOpen}ms` +
        `（跳板 ${hopClients.length} 级 · 本地端口 ${localPort}）`,
    )
  }
  return tunnel
}

/** 关闭隧道并释放资源 */
export function closeTunnel(tunnel: Tunnel | undefined): void {
  if (!tunnel) return
  for (const socket of tunnel.sockets) {
    try {
      socket.destroy()
    } catch {
      // 已销毁的连接不需要额外处理
    }
  }
  tunnel.sockets.clear()
  try {
    tunnel.server.close()
  } catch {
    // 未开始监听时 close 会抛错，忽略
  }
  // 自内向外收：先断最后一跳，再逐级断中间跳板，避免边界机上半开会话
  try {
    tunnel.client.end()
  } catch {
    // 同上
  }
  for (let i = tunnel.hopClients.length - 1; i >= 0; i -= 1) {
    try {
      tunnel.hopClients[i].end()
    } catch {
      // 已断开的跳板不需要处理
    }
  }
}

/**
 * 共享隧道管理器：按连接 id 持有隧道，供 connect() 长期复用。
 *
 * test() 不经过这里 —— 它用一次性独立隧道（见 openTunnel 的调用方），
 * 避免与 connect 的共享隧道互相拆除。
 */
export class TunnelManager {
  private tunnels = new Map<string, Tunnel>()

  /**
   * 取得可用的本地端口。
   *
   * 复用条件：配置指纹（地址/端口/用户名/认证方式）未变 **且** SSH 连接仍存活。
   *
   * 之前是无条件「先关旧开新」—— 与 test()/connect() 的调用时序叠加后是
   * "Connection is closed." 的直接来源：
   *   1. 对已连接的配置点「测试连接」：ensure 先拆掉正在承载流量的隧道，
   *      主界面活跃连接当场断流；
   *   2. 「测试连接」在途时点「保存并连接」：test 的 finally close 落在
   *      connect 刚建好的隧道之后，把它拆掉。
   * 配置变化或隧道已死（keepalive 失败等）则重建。
   */
  async ensure(config: TunnelTarget): Promise<{ host: string; port: number }> {
    const ssh = config.ssh
    if (!ssh) throw new Error(t('sshTunnel.missingSshConfiguration'))

    const existing = this.tunnels.get(config.id)
    if (existing && existing.alive && existing.key === tunnelKey(ssh)) {
      return { host: LOOPBACK, port: existing.localPort }
    }

    closeTunnel(existing)
    this.tunnels.delete(config.id)

    const tunnel = await openTunnel(config)
    this.tunnels.set(config.id, tunnel)
    return { host: LOOPBACK, port: tunnel.localPort }
  }

  close(id: string): void {
    closeTunnel(this.tunnels.get(id))
    this.tunnels.delete(id)
  }

  closeAll(): void {
    for (const tunnel of this.tunnels.values()) closeTunnel(tunnel)
    this.tunnels.clear()
  }

  has(id: string): boolean {
    return this.tunnels.has(id)
  }
}

export const tunnelManager = new TunnelManager()
