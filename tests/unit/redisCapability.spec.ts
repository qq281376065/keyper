import { describe, expect, it } from 'vitest'
import {
  describeVersion,
  parseRedisVersion,
  resolveCapabilities,
  versionAtLeast,
} from '@/utils/redisCapability'

describe('parseRedisVersion', () => {
  it('标准三段版本号', () => {
    expect(parseRedisVersion('7.4.0')).toEqual({ major: 7, minor: 4, patch: 0, raw: '7.4.0' })
  })

  it('两段版本补 patch=0', () => {
    const v = parseRedisVersion('7.2')
    expect(v?.major).toBe(7)
    expect(v?.minor).toBe(2)
    expect(v?.patch).toBe(0)
  })

  it('带后缀的构建串只取数字段，raw 保留原文', () => {
    const v = parseRedisVersion('7.4.0-rc1')
    expect(v?.major).toBe(7)
    expect(v?.minor).toBe(4)
    expect(v?.patch).toBe(0)
    expect(v?.raw).toBe('7.4.0-rc1')
  })

  it('无法解析返回 null', () => {
    expect(parseRedisVersion('abc')).toBeNull()
    expect(parseRedisVersion(undefined)).toBeNull()
  })
})

describe('versionAtLeast', () => {
  it('同大版本按 minor 比较', () => {
    const v = parseRedisVersion('7.4.0')
    expect(versionAtLeast(v, 7, 4)).toBe(true)
    expect(versionAtLeast(v, 7, 5)).toBe(false)
  })

  it('跨大版本直接比较 major', () => {
    expect(versionAtLeast(parseRedisVersion('8.0.0'), 7, 4)).toBe(true)
    expect(versionAtLeast(parseRedisVersion('6.2.14'), 7, 4)).toBe(false)
  })

  it('版本未知一律不支持', () => {
    expect(versionAtLeast(null, 7, 4)).toBe(false)
  })
})

describe('resolveCapabilities', () => {
  it('7.4 起开放 hash/set 字段级 TTL', () => {
    const c = resolveCapabilities('7.4.0')
    expect(c.versionKnown).toBe(true)
    expect(c.hashFieldTtl).toBe(true)
    expect(c.setMemberTtl).toBe(true)
  })

  it('低于 7.4 关闭字段级 TTL', () => {
    const c = resolveCapabilities('7.2.4')
    expect(c.versionKnown).toBe(true)
    expect(c.hashFieldTtl).toBe(false)
    expect(c.setMemberTtl).toBe(false)
  })

  it('版本未知时保守关闭（低版本上这些命令直接报错）', () => {
    const c = resolveCapabilities(undefined)
    expect(c.versionKnown).toBe(false)
    expect(c.hashFieldTtl).toBe(false)
    expect(c.setMemberTtl).toBe(false)
  })
})

describe('describeVersion', () => {
  it('有版本显示原文，无版本显示未知', () => {
    expect(describeVersion(resolveCapabilities('7.4.0'))).toBe('7.4.0')
    expect(describeVersion(resolveCapabilities(null))).toBe('未知')
  })
})