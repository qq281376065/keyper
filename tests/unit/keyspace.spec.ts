import { describe, expect, it } from 'vitest'
import { MEMORY_BUCKET_LIMIT, memoryPrefixOf } from '@shared/keyspace'

describe('memoryPrefixOf', () => {
  it('按 depth 取前 N 段', () => {
    expect(memoryPrefixOf('user:1001:name', 1)).toBe('user')
    expect(memoryPrefixOf('user:1001:name', 2)).toBe('user:1001')
    expect(memoryPrefixOf('user:1001:name', 3)).toBe('user:1001:name')
  })

  it('段数不足时返回完整键名（无分隔符键自成一组）', () => {
    expect(memoryPrefixOf('plain', 1)).toBe('plain')
    expect(memoryPrefixOf('a:b', 3)).toBe('a:b')
  })

  it('段数恰好等于 depth 时返回原键名', () => {
    expect(memoryPrefixOf('a:b', 2)).toBe('a:b')
  })
})

describe('MEMORY_BUCKET_LIMIT', () => {
  it('桶上限为 200（主进程与 mock 共用同一截断口径）', () => {
    expect(MEMORY_BUCKET_LIMIT).toBe(200)
  })
})