import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-lua-'))

vi.mock('@electron/services/config-path', () => ({
  configFile: (name: string) => path.join(process.env.RD_TEST_CONFIG_DIR as string, name),
  scriptsDir: () => path.join(process.env.RD_TEST_CONFIG_DIR as string, 'scripts'),
}))

import {
  listLuaScripts,
  removeLuaScript,
  removeLuaScripts,
  saveLuaScript,
} from '@electron/services/lua-script-store'

beforeAll(() => {
  process.env.RD_TEST_CONFIG_DIR = tmpRoot
})

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

const scriptsDir = (): string => path.join(tmpRoot, 'scripts')

function reset(): void {
  fs.rmSync(scriptsDir(), { recursive: true, force: true })
  fs.rmSync(path.join(tmpRoot, 'lua-scripts.json'), { force: true })
  fs.rmSync(path.join(tmpRoot, 'lua-scripts.json.migrated'), { force: true })
}

function names(): string[] {
  return listLuaScripts()
    .map((item) => item.name)
    .sort()
}

describe('lua-script-store · scripts 目录', () => {
  it('首次读取自动建 scripts 目录并返回空列表', () => {
    reset()
    expect(listLuaScripts()).toEqual([])
    expect(fs.existsSync(scriptsDir())).toBe(true)
  })

  it('每个脚本保存为独立的 .lua 文件，可直接从目录读回', () => {
    reset()
    const list = saveLuaScript({ name: '原子计数器', script: 'return 1' })
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('原子计数器.lua')
    expect(list[0].name).toBe('原子计数器')
    expect(list[0].script).toBe('return 1')
    expect(list[0].createdAt).toBeGreaterThan(0)
    expect(list[0].updatedAt).toBeGreaterThanOrEqual(list[0].createdAt)
    expect(fs.readFileSync(path.join(scriptsDir(), '原子计数器.lua'), 'utf-8')).toBe('return 1')

    // 外部手工放进目录的脚本也应出现在列表里
    fs.writeFileSync(path.join(scriptsDir(), 'manual.lua'), 'return "manual"', 'utf-8')
    expect(names()).toEqual(['manual', '原子计数器'])
    expect(listLuaScripts().find((item) => item.name === 'manual')?.script).toBe('return "manual"')
  })

  it('忽略非 .lua 文件与超过大小上限的文件', () => {
    reset()
    saveLuaScript({ name: 'ok', script: 'return 1' })
    fs.writeFileSync(path.join(scriptsDir(), 'notes.txt'), 'not a script', 'utf-8')
    fs.writeFileSync(path.join(scriptsDir(), 'huge.lua'), 'x'.repeat(256 * 1024 + 1), 'utf-8')
    expect(names()).toEqual(['ok'])
  })

  it('按 id 更新时保留文件，并把脚本移到最前', () => {
    reset()
    saveLuaScript({ name: 'first', script: 'return 1' })
    const [second] = saveLuaScript({ name: 'second', script: 'return 2' })

    const list = saveLuaScript({ id: second.id, name: 'second', script: 'return 22' })
    expect(list.map((item) => item.name)).toEqual(['second', 'first'])
    expect(list[0].id).toBe('second.lua')
    expect(list[0].script).toBe('return 22')
    expect(fs.existsSync(path.join(scriptsDir(), 'second.lua'))).toBe(true)
  })

  it('改名后旧文件消失、新文件生效，id 跟随文件名', () => {
    reset()
    const [item] = saveLuaScript({ name: 'old-name', script: 'return 1' })

    const list = saveLuaScript({ id: item.id, name: 'new-name', script: 'return 1' })
    expect(list[0].id).toBe('new-name.lua')
    expect(list[0].name).toBe('new-name')
    expect(fs.existsSync(path.join(scriptsDir(), 'old-name.lua'))).toBe(false)
    expect(fs.existsSync(path.join(scriptsDir(), 'new-name.lua'))).toBe(true)
    expect(names()).toEqual(['new-name'])
  })

  it('大小写不同的同名脚本会被拒绝', () => {
    reset()
    saveLuaScript({ name: 'Alpha', script: 'return 1' })
    expect(() => saveLuaScript({ name: 'alpha', script: 'return 2' })).toThrow()
    expect(names()).toEqual(['Alpha'])
  })

  it('非法文件名、纯空白与超长名称会被拒绝', () => {
    reset()
    expect(() => saveLuaScript({ name: '   ', script: 'return 1' })).toThrow()
    expect(() => saveLuaScript({ name: 'a/b', script: 'return 1' })).toThrow()
    expect(() => saveLuaScript({ name: 'trailing.', script: 'return 1' })).toThrow()
    expect(() => saveLuaScript({ name: 'CON', script: 'return 1' })).toThrow()
    expect(() => saveLuaScript({ name: 'x'.repeat(81), script: 'return 1' })).toThrow()
    expect(() => saveLuaScript({ name: 'big', script: 'x'.repeat(256 * 1024 + 1) })).toThrow()
    expect(listLuaScripts()).toEqual([])
  })

  it('删除只移除目标文件，批量删除忽略不存在的 id 与路径穿越', () => {
    reset()
    saveLuaScript({ name: 'A', script: 'return "a"' })
    const [b] = saveLuaScript({ name: 'B', script: 'return "b"' })
    const [c] = saveLuaScript({ name: 'C', script: 'return "c"' })

    expect(removeLuaScript(b.id).map((item) => item.name).sort()).toEqual(['A', 'C'])

    const outside = path.join(tmpRoot, 'outside.lua')
    fs.writeFileSync(outside, 'keep', 'utf-8')
    const list = removeLuaScripts([c.id, 'missing.lua', '../outside.lua'])
    expect(list.map((item) => item.name)).toEqual(['A'])
    expect(fs.existsSync(outside)).toBe(true)
  })

  it('旧版 lua-scripts.json 首次访问时导入为文件并改名留档', () => {
    reset()
    fs.writeFileSync(
      path.join(tmpRoot, 'lua-scripts.json'),
      JSON.stringify({
        version: 1,
        scripts: [
          { id: '1', name: '旧脚本', script: 'return 1', createdAt: 1, updatedAt: 1 },
          { id: '2', name: 'a/b', script: 'return 2', createdAt: 2, updatedAt: 2 },
          { id: '3', name: '旧脚本', script: 'return 3', createdAt: 3, updatedAt: 3 },
          { id: '4', name: 5, script: 'return 4' },
        ],
      }),
      'utf-8',
    )

    expect(names()).toEqual(['a_b', '旧脚本', '旧脚本 (2)'])
    expect(fs.existsSync(path.join(tmpRoot, 'lua-scripts.json'))).toBe(false)
    expect(fs.existsSync(path.join(tmpRoot, 'lua-scripts.json.migrated'))).toBe(true)

    // 再次读取不应重复导入
    expect(names()).toEqual(['a_b', '旧脚本', '旧脚本 (2)'])
  })
})
