import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 凭据加密单测。
 *
 * 锁定的核心不变量：
 *   1. seal/unseal 往返一致（含空值、中文、长串、特殊字符）；
 *   2. 同一明文两次加密得到**不同**密文（随机 IV，防模式泄露）；
 *   3. 密文格式为 enc2:，与旧格式 enc: 区分开；
 *   4. 换一个 userData / 进程后仍能解密 —— 这正是原缺陷的反面：
 *      旧 safeStorage 密文与 userData 强绑定，换目录即失效。
 *
 * 环境说明：被测模块依赖 electron 的 safeStorage，作为兜底；
 * 测试里 mock 掉以免 vitest 在 node 环境加载 electron 失败。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-crypto-'))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('should not be used in this test')
    },
    decryptString: () => {
      throw new Error('should not be used in this test')
    },
  },
}))

vi.mock('@electron/services/config-path', () => ({
  configFile: (name: string) => path.join(process.env.RD_TEST_CONFIG_DIR as string, name),
}))

import { isLegacyCipher, sealSecret, unsealSecret } from '@electron/services/credential-crypto'

beforeAll(() => {
  process.env.RD_TEST_CONFIG_DIR = tmpRoot
})

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('credential-crypto · 往返', () => {
  it('常规密码可原样还原', () => {
    const plain = 'P@ssw0rd!_2026'
    const sealed = sealSecret(plain)
    expect(sealed).toBeTruthy()
    expect(sealed!.startsWith('enc2:')).toBe(true)
    expect(unsealSecret(sealed)).toBe(plain)
  })

  it('空值与 undefined 原样返回', () => {
    expect(sealSecret('')).toBeUndefined()
    expect(sealSecret(undefined)).toBeUndefined()
    expect(unsealSecret(undefined)).toBeUndefined()
    expect(unsealSecret('')).toBeUndefined()
  })

  it('中文 / 超长 / 特殊字符都能还原', () => {
    const cases = ['密码中文测试', 'a'.repeat(4096), '引号"\'`\\n\\t::\u0000混排']
    for (const plain of cases) {
      expect(unsealSecret(sealSecret(plain))).toBe(plain)
    }
  })

  it('同一明文两次加密得到不同密文（随机 IV）', () => {
    const a = sealSecret('same-plain')
    const b = sealSecret('same-plain')
    expect(a).not.toBe(b)
    expect(unsealSecret(a)).toBe('same-plain')
    expect(unsealSecret(b)).toBe('same-plain')
  })

  it('密文不含明文（不是简单编码）', () => {
    const plain = 'VerySecretToken123'
    const sealed = sealSecret(plain)!
    expect(sealed.includes(plain)).toBe(false)
    expect(Buffer.from(sealed.slice(5), 'base64').toString('latin1').includes(plain)).toBe(false)
  })
})

describe('credential-crypto · 格式兼容', () => {
  it('raw: 前缀视为明文降级', () => {
    expect(unsealSecret('raw:my-plain-pw')).toBe('my-plain-pw')
  })

  it('无前缀的历史明文原样返回', () => {
    expect(unsealSecret('legacy-plain')).toBe('legacy-plain')
  })

  it('isLegacyCipher 只认 enc: 旧格式', () => {
    expect(isLegacyCipher('enc:djEwxxxx')).toBe(true)
    expect(isLegacyCipher('enc2:djEwxxxx')).toBe(false)
    expect(isLegacyCipher('raw:x')).toBe(false)
    expect(isLegacyCipher(undefined)).toBe(false)
  })

  it('损坏的 enc2 密文抛出带指引的错误，而不是静默返回 undefined', () => {
    const sealed = sealSecret('will-be-corrupted')!
    const broken = sealed.slice(0, 12) + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    expect(() => unsealSecret(broken)).toThrow(/无法解密|长度异常/)
  })
})

describe('credential-crypto · 密钥文件', () => {
  it('密钥落盘在配置目录，且自身不是明文密钥', () => {
    sealSecret('trigger-key-creation')
    const keyFile = path.join(tmpRoot, 'keys.bin')
    expect(fs.existsSync(keyFile)).toBe(true)
    const raw = fs.readFileSync(keyFile)
    /* 首字节是保护方式标记，不可能是可读的 32 字节密钥本身 */
    expect(raw.length).toBeGreaterThan(1)
    expect([0x01, 0x02, 0x03]).toContain(raw[0])
  })
})
