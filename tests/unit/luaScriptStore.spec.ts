import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-lua-'))

vi.mock('@electron/services/config-path', () => ({
  configFile: (name: string) => path.join(process.env.RD_TEST_CONFIG_DIR as string, name),
}))

import { listLuaScripts, removeLuaScript, removeLuaScripts, saveLuaScript } from '@electron/services/lua-script-store'

beforeAll(() => {
  process.env.RD_TEST_CONFIG_DIR = tmpRoot
})

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function reset(): void {
  fs.rmSync(path.join(tmpRoot, 'lua-scripts.json'), { force: true })
}

describe('lua-script-store · 持久化', () => {
  it('新建后可按名称读回，并带上创建 / 更新时间', () => {
    reset()
    expect(listLuaScripts()).toEqual([])

    const list = saveLuaScript({ name: '  原子计数器  ', script: 'return 1' })
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('原子计数器')
    expect(list[0].script).toBe('return 1')
    expect(list[0].id).toBeTruthy()
    expect(list[0].createdAt).toBeGreaterThan(0)
    expect(list[0].updatedAt).toBeGreaterThanOrEqual(list[0].createdAt)
    expect(listLuaScripts()).toEqual(list)
  })

  it('按 id 更新时保留 createdAt，并把脚本移到最前', () => {
    reset()
    saveLuaScript({ name: '第一个', script: 'return 1' })
    const [second] = saveLuaScript({ name: '第二个', script: 'return 2' })
    const createdAt = second.createdAt

    const list = saveLuaScript({ id: second.id, name: '第二个（改）', script: 'return 22' })
    expect(list.map((item) => item.name)).toEqual(['第二个（改）', '第一个'])
    expect(list[0].createdAt).toBe(createdAt)
    expect(list[0].updatedAt).toBeGreaterThanOrEqual(createdAt)
    expect(list[0].script).toBe('return 22')
  })

  it('删除只移除目标脚本', () => {
    reset()
    saveLuaScript({ name: 'A', script: 'return "a"' })
    const [b] = saveLuaScript({ name: 'B', script: 'return "b"' })

    const list = removeLuaScript(b.id)
    expect(list.map((item) => item.name)).toEqual(['A'])
  })

  it('批量删除一次移除多个脚本，忽略不存在的 id', () => {
    reset()
    saveLuaScript({ name: 'A', script: 'return "a"' })
    const [b] = saveLuaScript({ name: 'B', script: 'return "b"' })
    const [c] = saveLuaScript({ name: 'C', script: 'return "c"' })

    const list = removeLuaScripts([b.id, c.id, 'missing'])
    expect(list.map((item) => item.name)).toEqual(['A'])
    expect(listLuaScripts().map((item) => item.name)).toEqual(['A'])
  })

  it('空名称与超大脚本会被拒绝', () => {
    reset()
    expect(() => saveLuaScript({ name: '   ', script: 'return 1' })).toThrow()
    expect(() => saveLuaScript({ name: 'big', script: 'x'.repeat(256 * 1024 + 1) })).toThrow()
  })

  it('损坏的 JSON 回退为空列表，不影响后续保存', () => {
    reset()
    fs.writeFileSync(path.join(tmpRoot, 'lua-scripts.json'), '{ broken', 'utf-8')
    expect(listLuaScripts()).toEqual([])
    expect(saveLuaScript({ name: '恢复', script: 'return 1' })).toHaveLength(1)
  })
})
