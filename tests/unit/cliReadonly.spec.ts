import { describe, expect, it } from 'vitest'
import { isReadonlyCliCommand } from '@/utils/cliReadonly'

describe('isReadonlyCliCommand', () => {
  it('目录标记的只读 / 写入命令', () => {
    expect(isReadonlyCliCommand('GET foo')).toBe(true)
    expect(isReadonlyCliCommand('SET foo bar')).toBe(false)
    expect(isReadonlyCliCommand('HGETALL user:1')).toBe(true)
    expect(isReadonlyCliCommand('XADD stream * f v')).toBe(false)
  })

  it('容器子命令兜底', () => {
    expect(isReadonlyCliCommand('CLIENT LIST')).toBe(true)
    expect(isReadonlyCliCommand('CONFIG GET maxmemory')).toBe(true)
    expect(isReadonlyCliCommand('CONFIG SET maxmemory 1gb')).toBe(false)
  })

  it('高危写入命令不算只读', () => {
    expect(isReadonlyCliCommand('FLUSHDB')).toBe(false)
    expect(isReadonlyCliCommand('SCRIPT FLUSH')).toBe(false)
  })

  it('空命令按只读处理，避免误刷新', () => {
    expect(isReadonlyCliCommand('   ')).toBe(true)
  })
})
