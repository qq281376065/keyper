import fs from 'node:fs'
import path from 'node:path'
import type { RedisConnectionConfig, SshConfig, SshHop } from '../../shared/types'
import { configFile } from './config-path'
import { isLegacyCipher, sealSecret, unsealSecret } from './credential-crypto'

/**
 * 连接配置持久化。
 * 落盘位置：<配置目录>/connections.json
 * 配置目录默认是「程序目录/config」（便携），不可写时回退 userData，见 config-path.ts
 *
 * 密码处理策略见 credential-crypto.ts：
 *   凭据用「应用级密钥 + AES-256-GCM」加密（新格式 enc2:），
 *   密钥本身用 safeStorage（DPAPI）保护、存放在**配置目录**下的 keys.bin。
 *   这样密文不再与 userData 目录绑定 —— dev/打包版切换、换安装位置、
 *   便携目录换盘符都不会让已保存的密码失效。
 *   旧格式 enc:（safeStorage 直连密文）仍可解，保存时自动迁移为 enc2:。
 */

const FILE_NAME = 'connections.json'

function storeFile(): string {
  return configFile(FILE_NAME)
}

function encryptPassword(plain?: string): string | undefined {
  return sealSecret(plain)
}

/**
 * 解密密码。
 *
 * ⚠️ 解密失败**不能静默返回 undefined**。
 *
 * 若安静地返回 undefined，界面看到的是"密码为空"，用户会以为是自己没填密码，
 * 反复重填也没用 —— 因为下次读盘又把新密码覆盖成新密文（能解开），
 * 但**旧的那条**永远是坏的，极难自查。
 *
 * 这里改成：解密失败时抛出带原因的错误，由上层决定如何呈现。
 * 用 raw: 明文前缀存储的（降级路径）不受影响。
 *
 * 密文格式与容错详见 credential-crypto.ts。
 */
function decryptPassword(stored?: string): string | undefined {
  if (!stored) return undefined
  try {
    return unsealSecret(stored)
  } catch (error) {
    /*
     * 具体原因交给调用方展示（不同场景措辞不同），
     * 这里只标记"密文无法解开"这一事实，不吞掉。
     */
    throw new SecureStringError(
      error instanceof Error ? error.message : String(error),
    )
  }
}

/** 凭据解密失败 —— 与"网络不通"区分开，便于界面给出针对性提示 */
export class SecureStringError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecureStringError'
  }
}

interface PersistedShape extends Omit<RedisConnectionConfig, 'password' | 'ssh'> {
  password?: string
  /**
   * SSH 配置也含凭据（登录密码 / 私钥口令），与 Redis 密码同等待遇。
   * 私钥正文本身不算机密（用户从文件里粘贴，磁盘上已有），不做加密以免拖慢读写。
   */
  ssh?: SshConfig
}

/**
 * 只加密凭据字段，其余原样透传。
 * SSH 私钥内容可能长达数 KB，逐字段改写而不是整体序列化，
 * 避免在加解密时反复拼装大字符串。
 * 中间跳板（hops）的登录密码/口令与本体同等待遇 —— 堡垒机链上
 * 每一跳都是独立凭据，任何一环明文落盘都是泄露点。
 */
function sealSsh(ssh: SshConfig | undefined): SshConfig | undefined {
  if (!ssh) return undefined
  return {
    ...ssh,
    password: ssh.password ? encryptPassword(ssh.password) : undefined,
    passphrase: ssh.passphrase ? encryptPassword(ssh.passphrase) : undefined,
    hops: sealHops(ssh.hops),
  }
}

function unsealSsh(ssh: SshConfig | undefined): SshConfig | undefined {
  if (!ssh) return undefined
  return {
    ...ssh,
    password: decryptPassword(ssh.password),
    passphrase: decryptPassword(ssh.passphrase),
    hops: unsealHops(ssh.hops),
  }
}

/** 跳板凭据加密；空数组归一为 undefined，落盘不带无意义的 hops: [] */
function sealHops(hops: SshHop[] | undefined): SshHop[] | undefined {
  if (!hops?.length) return undefined
  return hops.map((hop) => ({
    ...hop,
    password: hop.password ? encryptPassword(hop.password) : undefined,
    passphrase: hop.passphrase ? encryptPassword(hop.passphrase) : undefined,
  }))
}

function unsealHops(hops: SshHop[] | undefined): SshHop[] | undefined {
  if (!hops?.length) return undefined
  return hops.map((hop) => ({
    ...hop,
    password: decryptPassword(hop.password),
    passphrase: decryptPassword(hop.passphrase),
  }))
}

/**
 * 单个凭据的写盘策略：有明文就加密；
 * 明文缺失（undefined）且磁盘上有旧密文时原样保留。
 * （"原样保留"针对的场景与不可逆风险见 saveConnections 的注释。）
 */
function preserveCredential(incoming: string | undefined, prev: string | undefined): string | undefined {
  return incoming === undefined && prev ? prev : encryptPassword(incoming)
}

/**
 * SSH 凭据合并（本体 + 每一跳），策略与主密码一致。
 *
 * ⚠️ 保留路径不得经过 sealSsh —— sealSsh 的语义是"对明文加密"，
 * 喂给它密文会产生双重加密，下次解密得到 "enc:xxx" 字面量。
 *
 * 跳板按序号对齐：用户删过/重排过跳板后序号可能错位，
 * 错位的后果只是"保留了不匹配的旧密文"（等价于没保留，
 * 重新输入即可恢复），不会污染磁盘上其他密文。
 */
function mergeSsh(item: SshConfig, prevSsh: SshConfig): SshConfig {
  return {
    ...item,
    password: preserveCredential(item.password, prevSsh.password),
    passphrase: preserveCredential(item.passphrase, prevSsh.passphrase),
    hops: item.hops?.map((hop, index) => {
      const prevHop = prevSsh.hops?.[index]
      return {
        ...hop,
        password: preserveCredential(hop.password, prevHop?.password),
        passphrase: preserveCredential(hop.passphrase, prevHop?.passphrase),
      }
    }),
  }
}

export function loadConnections(): RedisConnectionConfig[] {
  const file = storeFile()
  if (!fs.existsSync(file)) return []
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const list = JSON.parse(raw) as PersistedShape[]
    if (!Array.isArray(list)) return []

    /*
     * 逐条解密、逐条容错。
     *
     * 不能让一条密文解不开就把整份配置丢掉（外层 catch 会返回 []）——
     * 那样用户会看到"所有连接都消失了"，比密码丢失严重得多。
     * 单条失败时保留这条配置的其余字段（地址、端口仍可用），
     * password 置空并把原因挂在 credentialError 上，
     * 界面据此提示"密码需重新输入"而不是笼统的"连接失败"。
     */
    let needsMigration = false
    const result = list.map((item) => {
      let password: string | undefined
      let credentialError: string | undefined
      try {
        password = decryptPassword(item.password)
        /* 旧格式（enc:）解密成功后标记待迁移，见下方就地重写 */
        if (isLegacyCipher(item.password)) needsMigration = true
      } catch (error) {
        credentialError = error instanceof Error ? error.message : String(error)
      }

      /*
       * SSH 凭据解密失败时**不能把密文形态的 ssh 原样交回界面**。
       *
       * 曾经的做法是 `ssh = item.ssh`（密文保留），后果链条：
       *   编辑对话框把 "enc:xxx" 密文当成密码回填进输入框 →
       *   用户看到框里有值、以为凭据完好 → 保存 →
       *   saveConnections 对密文再加密（双重加密）→
       *   下次解密得到字面量 "enc:xxx" → SSH 拿它当密码 →
       *   "All configured authentication methods failed"。
       * 凭据置空 + credentialError 提示，密码框显示为空，
       * 用户重填一次即可恢复，不会无声污染磁盘密文。
       */
      let ssh = item.ssh
      if (ssh) {
        // 固定为非空类型：catch 块里 ssh 的流类型会并上 unsealSsh 的返回
        //（SshConfig | undefined），直接展开会把所有字段摊成 optional
        const original = ssh
        try {
          ssh = unsealSsh(original)
        } catch (error) {
          credentialError ??= error instanceof Error ? error.message : String(error)
          /*
           * 置空范围必须覆盖每一跳：中间跳板的密文若原样交回界面，
           * 会经编辑框回填 → 保存再加密 → 双重加密，与本体密码同病。
           */
          ssh = {
            ...original,
            password: undefined,
            passphrase: undefined,
            hops: original.hops?.map((hop) => ({ ...hop, password: undefined, passphrase: undefined })),
          }
        }
      }

      return { ...item, password, ssh, credentialError }
    })

    /*
     * 旧格式迁移（就地重写）。
     *
     * 旧格式 enc: 的密文与 userData 目录绑定：本次能解开，只因当前仍在
     * 同一个 userData 下；一旦换安装位置/换 dev 与打包版，立刻全部失效。
     * 所以只要本次成功解密出明文，就立刻改写为与应用级密钥绑定的 enc2:，
     * 不给用户留下"某天突然解不开"的定时炸弹。
     *
     * 失败不影响返回值：迁移是加固动作，写盘出错时本次仍按已解密结果使用。
     */
    if (needsMigration) {
      try {
        /*
         * 逐条就地改写：只把「旧格式且已成功解密」的凭据换成 enc2 密文，
         * 其余字段与其他条目原样保留（不做整体重写，避免误伤未解开或已删除的条目）。
         */
        let changed = false
        for (const item of list) {
          if (!isLegacyCipher(item.password)) continue
          let plain: string | undefined
          try {
            plain = unsealSecret(item.password)
          } catch {
            continue /* 解不开的不动，交给界面提示重填 */
          }
          if (plain === undefined) continue
          const sealed = sealSecret(plain)
          if (sealed && sealed !== item.password) {
            item.password = sealed
            changed = true
          }
          /* SSH 凭据同步迁移（本体 + 每一跳） */
          if (item.ssh) changed = migrateSshCiphers(item.ssh) || changed
        }
        if (changed) {
          fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf-8')
        }
        if (process.env.REDISDOCTER_DEBUG) {
          console.error(`[connection-store] 迁移检查: changed=${changed} 条目=${list.length}`)
        }
      } catch (error) {
        console.error('[connection-store] 旧密文迁移失败（不影响本次使用）:', error)
      }
    }

    return result
  } catch (error) {
    console.error('[connection-store] 读取连接配置失败:', error)
    return []
  }
}

/**
 * SSH 凭据的旧格式迁移（本体 + 每一跳）。
 * 只处理 enc: 形态且能解开的字段，返回是否有改动。
 */
function migrateSshCiphers(ssh: SshConfig): boolean {
  let changed = false
  const upgrade = (value: string | undefined): string | undefined => {
    if (!isLegacyCipher(value)) return value
    try {
      const plain = unsealSecret(value)
      if (plain === undefined) return value
      const sealed = sealSecret(plain)
      if (sealed && sealed !== value) changed = true
      return sealed ?? value
    } catch {
      return value
    }
  }
  const nextPassword = upgrade(ssh.password)
  const nextPassphrase = upgrade(ssh.passphrase)
  ssh.password = nextPassword
  ssh.passphrase = nextPassphrase
  if (ssh.hops) {
    for (const hop of ssh.hops) {
      hop.password = upgrade(hop.password)
      hop.passphrase = upgrade(hop.passphrase)
    }
  }
  return changed
}

export function saveConnections(list: RedisConnectionConfig[]): void {
  const file = storeFile()

  /*
   * 先读出磁盘上现有的密文，用于"原样保留解不开的密码"。
   *
   * 场景：某条配置的密文因换账户而解不开，loadConnections 会把它读成
   * password=undefined + credentialError。此时用户如果只是改了名称或端口
   * 再保存，直接按 password=undefined 写回，就会把**原始密文抹掉** ——
   * 换回原账户也恢复不了了，属于不可逆的数据损坏。
   *
   * 因此：password 为 undefined 且磁盘上原有密文时，保留原密文不动。
   */
  const existing = new Map<string, PersistedShape>()
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as PersistedShape[]
      if (Array.isArray(parsed)) for (const item of parsed) existing.set(item.id, item)
    }
  } catch {
    /* 读不出来就当没有旧数据，按传入内容写 */
  }

  const payload: PersistedShape[] = list.map((item) => {
    /*
     * 剔除 credentialError：它是运行时诊断信息，不落盘。
     * 用显式解构而不是 `...item`，避免以后再加运行时字段时又漏进来。
     */
    const { credentialError: _drop, ...rest } = item

    const prev = existing.get(item.id)
    const password =
      item.password === undefined && prev?.password
        ? prev.password
        : encryptPassword(item.password)

    /*
     * SSH 凭据（本体 + 每一跳）同样需要"原样保留解不开的密文"保护，
     * 与上面主密码同等待遇 —— 规则集中在 mergeSsh：
     *   undefined 且磁盘有旧密文 → 原样写入（不经 sealSsh，防双重加密）；
     *   否则按明文加密。
     *
     * 边界：item.ssh 整体为 undefined 时不保留 —— 用户清空 SSH
     * 配置（或表单里 host 为空）是明确的"删除"意图，照写 undefined。
     */
    const prevSsh = prev?.ssh
    const ssh = item.ssh && prevSsh ? mergeSsh(item.ssh, prevSsh) : sealSsh(item.ssh)

    return {
      ...rest,
      password,
      ssh,
    }
  })

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8')
}
