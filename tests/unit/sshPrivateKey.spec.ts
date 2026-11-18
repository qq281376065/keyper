import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * SSH 私钥加密落盘 + 历史明文迁移。
 *
 * 锁定的不变量（roadmap 1.4 / 审计 BUG-4）：
 *   1. 保存后磁盘上的 privateKey 是 enc2: 密文，不是明文；
 *   2. 读取时还原为明文（编辑框回填、ssh2 拿到的都是可用私钥）；
 *   3. 历史明文私钥（1.1.9 及更早无前缀）读取后自动迁移为 enc2:；
 *   4. 「只改名字保存」不抹掉磁盘上的旧私钥密文（preserveCredential 语义）；
 *   5. 跳板（hops）私钥与本体同等待遇。
 *
 * 环境：mock electron safeStorage（DPAPI 不可用分支）与 config-path，
 * 与 credentialCrypto.spec 同一套隔离手法。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-sshkey-'))

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

import { loadConnections, saveConnections } from '@electron/services/connection-store'
import type { RedisConnectionConfig } from '@shared/types'

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----'

function conn(overrides: Partial<RedisConnectionConfig> = {}): RedisConnectionConfig {
  return {
    id: 'c1',
    engine: 'redis',
    name: 'test',
    host: '127.0.0.1',
    port: 6379,
    db: 0,
    sshEnabled: true,
    ssh: {
      host: 'bastion',
      port: 22,
      username: 'root',
      authMethod: 'key',
      privateKey: PRIVATE_KEY,
    },
    ...overrides,
  } as RedisConnectionConfig
}

function diskList(): Array<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(tmpRoot, 'connections.json'), 'utf-8'))
}

beforeAll(() => {
  process.env.RD_TEST_CONFIG_DIR = tmpRoot
})

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('ssh privateKey · 加密落盘', () => {
  it('保存后磁盘是 enc2 密文，读取还原明文', () => {
    saveConnections([conn()])
    const onDisk = diskList()[0] as { ssh: { privateKey: string } }
    expect(onDisk.ssh.privateKey.startsWith('enc2:')).toBe(true)
    expect(onDisk.ssh.privateKey).not.toContain('BEGIN OPENSSH')

    const loaded = loadConnections()
    expect(loaded[0]!.ssh!.privateKey).toBe(PRIVATE_KEY)
  })

  it('历史明文私钥读取后自动迁移为 enc2', () => {
    /* 手工构造 1.1.9 形态：私钥无前缀明文 */
    const legacy = [{
      id: 'c2', engine: 'redis', name: 'legacy', host: 'h', port: 6379, db: 0,
      ssh: { host: 'b', port: 22, username: 'r', authMethod: 'key', privateKey: PRIVATE_KEY },
    }]
    fs.writeFileSync(path.join(tmpRoot, 'connections.json'), JSON.stringify(legacy), 'utf-8')

    const loaded = loadConnections()
    expect(loaded[0]!.ssh!.privateKey).toBe(PRIVATE_KEY)

    const onDisk = diskList()[0] as { ssh: { privateKey: string } }
    expect(onDisk.ssh.privateKey.startsWith('enc2:')).toBe(true)
  })

  it('只改名字保存不抹掉旧私钥密文', () => {
    saveConnections([conn()])
    const sealedBefore = (diskList()[0] as { ssh: { privateKey: string } }).ssh.privateKey

    /* 模拟「密文解不开 → 界面回填 undefined → 用户只改名字」：
       loadConnections 对坏密文置空 privateKey，保存时应保留磁盘旧密文 */
    const loaded = loadConnections()
    const renamed = { ...loaded[0]!, name: 'renamed', ssh: { ...loaded[0]!.ssh!, privateKey: undefined } }
    saveConnections([renamed as RedisConnectionConfig])

    const onDisk = diskList()[0] as { name: string; ssh: { privateKey: string } }
    expect(onDisk.name).toBe('renamed')
    expect(onDisk.ssh.privateKey).toBe(sealedBefore)
  })

  it('跳板私钥同样加密', () => {
    const withHop = conn()
    withHop.ssh!.hops = [{
      host: 'hop1', port: 22, username: 'r', authMethod: 'key', privateKey: PRIVATE_KEY,
    }]
    saveConnections([withHop])
    const onDisk = diskList()[0] as { ssh: { hops: Array<{ privateKey: string }> } }
    expect(onDisk.ssh.hops[0]!.privateKey.startsWith('enc2:')).toBe(true)
    expect(loadConnections()[0]!.ssh!.hops![0]!.privateKey).toBe(PRIVATE_KEY)
  })

  it('空私钥不落盘字段', () => {
    /* 用全新 id：preserveCredential 对「undefined + 磁盘旧密文」会保留旧值，
       那是「密文解不开」的保护语义，不是本用例要测的「从未有过私钥」 */
    const noKey = conn({ id: 'c-nokey' })
    noKey.ssh!.authMethod = 'password'
    noKey.ssh!.password = 'pw'
    noKey.ssh!.privateKey = undefined
    saveConnections([noKey])
    const onDisk = diskList().find((c) => c.id === 'c-nokey') as { ssh: Record<string, unknown> }
    expect(onDisk.ssh.privateKey).toBeUndefined()
    expect(onDisk.ssh.password).toBeTruthy()
  })
})