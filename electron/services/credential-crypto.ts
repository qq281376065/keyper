import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { safeStorage } from 'electron'
import { t } from '@shared/i18n'
import { configFile } from './config-path'

/**
 * 凭据加密（应用级密钥 + AES-256-GCM）。
 *
 * ════════════════════════════════════════════════════════════════════
 * 一、为什么不能直接用 safeStorage.encryptString
 *
 * 实测（Windows 10 / Electron 33）：safeStorage 的 AES 密钥由 Chromium
 * 生成并存放在 **userData 目录**的 `Local State → os_crypt.encrypted_key`
 * （DPAPI 保护）。于是密文与「userData 目录」强绑定，而该目录会随下列
 * 情况变化：
 *   · dev 模式（app 名 Electron）与打包版（Keyper）不同；
 *   · 换安装位置 / 用 --user-data-dir 启动 / 便携 U 盘换盘符；
 *   · 同一 exe 换到另一台机器或另一个 Windows 账户。
 * 一旦变化，旧密文全部解不开 —— 用户看到的就是
 * 「保存的密码无法解密，请重新输入」，重存后下次又坏。
 *
 * 对照实测（同一密文，只换 userData 目录）：
 *   userData=...\Keyper → 解密成功
 *   userData=...\Electron    → Error while decrypting the ciphertext
 *
 * 二、本模块的方案
 *
 * 自建应用级密钥，密钥保护**不依赖 userData**：
 *   1. 32 字节随机 AES 密钥，存放在**配置目录**的 keys.bin
 *      （与 connections.json 同目录 → 便携模式下随程序目录一起搬走）；
 *   2. keys.bin 的保护顺序：
 *        ① DPAPI（Windows 内建，绑定「当前用户」，与 userData 无关）
 *        ② safeStorage（DPAPI 不可用时的后备，含非 Windows 平台）
 *        ③ 裸字节 + 0600（两者都不可用的极端环境）
 *   3. 凭据用 AES-256-GCM 加密，密文自带版本号与随机 IV。
 *
 * 这样：同一 Windows 账户下，dev / 打包版 / 换安装位置 / 换盘符
 * 都能解开；换 Windows 账户则如设计般失效（符合"凭据只属于本人"）。
 *
 * 三、旧密文兼容
 *   仍能解 `enc:` 形态（旧 safeStorage 直连密文），读到后立即改写为
 *   `enc2:` 新格式（见 connection-store 的迁移逻辑），避免留下
 *   "今天能开、明天换目录就打不开"的定时炸弹。
 * ════════════════════════════════════════════════════════════════════
 */

/** 新格式：enc2: + base64(iv(12) | tag(16) | ciphertext) */
const PREFIX_V2 = 'enc2:'
/** 旧格式：safeStorage 密文（与 userData 绑定） */
const PREFIX_V1 = 'enc:'
/** 降级明文 */
const PREFIX_RAW = 'raw:'

const KEY_FILE = 'keys.bin'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** keys.bin 首字节：保护方式 */
const MODE_DPAPI = 0x01
const MODE_SAFESTORAGE = 0x02
const MODE_PLAIN = 0x03

let cachedKey: Buffer | null = null

function keyFilePath(): string {
  return path.join(path.dirname(configFile(KEY_FILE)), KEY_FILE)
}

/**
 * 用 DPAPI（当前用户作用域）加密/解密。
 *
 * Electron 未暴露 DPAPI，走 PowerShell 的 ProtectedData。
 * 只在「首次生成密钥」与「启动时读取密钥」各调用一次，开销可忽略；
 * 失败返回 null 交由 safeStorage 兜底。
 *
 * 注意：输入输出用 base64 传递，避免 UTF-8 字节在命令行参数里被转义破坏。
 */
function dpapi(input: Buffer, mode: 'protect' | 'unprotect'): Buffer | null {
  if (process.platform !== 'win32') return null
  const b64 = input.toString('base64')
  const method = mode === 'protect' ? 'Protect' : 'Unprotect'
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    `$data = [Convert]::FromBase64String('${b64}')`,
    `$out = [System.Security.Cryptography.ProtectedData]::${method}($data, $null, 'CurrentUser')`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ')

  try {
    const output = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf-8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const trimmed = output.trim()
    if (!trimmed) return null
    return Buffer.from(trimmed, 'base64')
  } catch {
    return null
  }
}

/** 读 keys.bin；不存在返回 null */
function readKeyFile(): Buffer | null {
  const file = keyFilePath()
  if (!fs.existsSync(file)) return null
  const raw = fs.readFileSync(file)
  if (raw.length < 2) return null
  const mode = raw[0]
  const body = raw.subarray(1)

  if (mode === MODE_DPAPI) {
    const key = dpapi(body, 'unprotect')
    return key && key.length === KEY_BYTES ? key : null
  }
  if (mode === MODE_SAFESTORAGE) {
    try {
      const key = Buffer.from(safeStorage.decryptString(body), 'base64')
      return key.length === KEY_BYTES ? key : null
    } catch {
      return null
    }
  }
  if (mode === MODE_PLAIN) {
    return body.length === KEY_BYTES ? Buffer.from(body) : null
  }
  return null
}

/** 写 keys.bin：DPAPI 优先，其次 safeStorage，最后裸字节 */
function writeKeyFile(key: Buffer): void {
  const file = keyFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const wrapped = dpapi(key, 'protect')
  if (wrapped) {
    fs.writeFileSync(file, Buffer.concat([Buffer.from([MODE_DPAPI]), wrapped]), { mode: 0o600 })
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const body = safeStorage.encryptString(key.toString('base64'))
      fs.writeFileSync(file, Buffer.concat([Buffer.from([MODE_SAFESTORAGE]), body]), { mode: 0o600 })
      return
    } catch {
      /* 继续降级 */
    }
  }
  fs.writeFileSync(file, Buffer.concat([Buffer.from([MODE_PLAIN]), key]), { mode: 0o600 })
}

/**
 * 取（或首次创建）应用级主密钥。
 *
 * ⚠️ 读到了但解不开时**绝不重建** —— 重建会让磁盘上所有 enc2 密文作废，
 * 属于不可逆的数据损坏。此时抛出，由上层提示「重新输入密码」。
 */
function masterKey(): Buffer {
  if (cachedKey) return cachedKey

  const existing = (() => {
    try {
      return readKeyFile()
    } catch (error) {
      throw new Error(
        t('credentialCrypto.failedReadKeyFile', {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  })()

  if (existing) {
    cachedKey = existing
    return existing
  }

  /* 文件存在但解不开 → 不覆盖，报错（换 Windows 账户 / 文件损坏） */
  if (fs.existsSync(keyFilePath())) {
    throw new Error(
      t('credentialCrypto.keyFileNotParsed'),
    )
  }

  const key = crypto.randomBytes(KEY_BYTES)
  writeKeyFile(key)
  cachedKey = key
  return key
}

function encryptV2(plain: string): string {
  const key = masterKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX_V2 + Buffer.concat([iv, tag, body]).toString('base64')
}

function decryptV2(stored: string): string {
  const buf = Buffer.from(stored.slice(PREFIX_V2.length), 'base64')
  if (buf.length <= IV_BYTES + TAG_BYTES) throw new Error(t('credentialCrypto.ciphertextLengthInvalid'))
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = buf.subarray(IV_BYTES + TAG_BYTES)
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

/** 加密一个凭据字段 */
export function sealSecret(plain?: string): string | undefined {
  if (!plain) return undefined
  try {
    return encryptV2(plain)
  } catch {
    /* 密钥不可用：降级明文，避免静默丢数据（与原策略一致） */
    return PREFIX_RAW + plain
  }
}

/**
 * 解密一个凭据字段。
 * 兼容 enc2（新）/ enc（旧 safeStorage）/ raw（明文降级）/ 无前缀（历史遗留明文）。
 * @throws 密文无法解开时抛出（措辞供界面直接展示）
 */
export function unsealSecret(stored?: string): string | undefined {
  if (!stored) return undefined

  if (stored.startsWith(PREFIX_V2)) {
    try {
      return decryptV2(stored)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        t('credentialCrypto.passwordDecryptFailed', { error: detail }),
      )
    }
  }

  if (stored.startsWith(PREFIX_V1)) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(PREFIX_V1.length), 'base64'))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        t(
          'credentialCrypto.legacyPasswordDecryptFailed',
          { error: detail },
        ),
      )
    }
  }

  if (stored.startsWith(PREFIX_RAW)) return stored.slice(PREFIX_RAW.length)
  return stored
}

/** 是否旧格式（需要迁移） */
export function isLegacyCipher(stored?: string): boolean {
  if (!stored) return false
  return stored.startsWith(PREFIX_V1)
}

/** 供自检/诊断 */
export function keyStatus(): {
  file: string
  exists: boolean
  mode: string | null
  platform: string
  home: string
} {
  const file = keyFilePath()
  let mode: string | null = null
  try {
    if (fs.existsSync(file)) {
      const first = fs.readFileSync(file)[0]
      mode = first === MODE_DPAPI ? 'dpapi' : first === MODE_SAFESTORAGE ? 'safeStorage' : first === MODE_PLAIN ? 'plain' : `unknown(${first})`
    }
  } catch {
    mode = 'unreadable'
  }
  return { file, exists: fs.existsSync(file), mode, platform: process.platform, home: os.homedir() }
}
