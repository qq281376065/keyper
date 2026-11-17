import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatTtl,
  MAX_TIMER_DELAY,
  oneLine,
  prettyJson,
  remainingTtl,
  ttlAtOf,
  ttlRecheckDelay,
  ttlTone,
} from '@/utils/format'

describe('formatTtl', () => {
  it('特殊语义值', () => {
    expect(formatTtl(-1)).toBe('永久')
    expect(formatTtl(-2)).toBe('已过期')
  })

  it('秒 / 分 / 时 / 天分档', () => {
    expect(formatTtl(59)).toBe('59s')
    expect(formatTtl(61)).toBe('1m1s')
    expect(formatTtl(3600)).toBe('1h0m')
    expect(formatTtl(3661)).toBe('1h1m')
    expect(formatTtl(86400)).toBe('1d0h')
    expect(formatTtl(90061)).toBe('1d1h')
  })
})

describe('remainingTtl', () => {
  it('按时间戳递减，过期归零', () => {
    expect(remainingTtl(60, 1000, 1000)).toBe(60)
    expect(remainingTtl(60, 1000, 61000)).toBe(0)
    expect(remainingTtl(60, 1000, 121000)).toBe(0)
    expect(remainingTtl(60, 1000, 31000)).toBe(30)
  })

  it('特殊语义值原样返回', () => {
    expect(remainingTtl(-1, 1000, 9999999)).toBe(-1)
    expect(remainingTtl(-2, 1000, 9999999)).toBe(-2)
  })

  it('时间倒流时按 0 秒已流逝处理', () => {
    expect(remainingTtl(60, 5000, 1000)).toBe(60)
  })
})

describe('ttlAtOf', () => {
  it('读取附加时间戳，缺失返回 undefined', () => {
    expect(ttlAtOf({ ttlAt: 12345 })).toBe(12345)
    expect(ttlAtOf({})).toBeUndefined()
  })
})

describe('ttlRecheckDelay', () => {
  it('普通 TTL 留 300ms 余量', () => {
    expect(ttlRecheckDelay(60)).toBe(60_300)
    expect(ttlRecheckDelay(3_600)).toBe(3_600_300)
  })

  it('超过 32 位上限的长 TTL 钳到上限，不能溢出成立即触发', () => {
    const days30 = 30 * 24 * 3600
    const days90 = 90 * 24 * 3600
    expect(ttlRecheckDelay(days30)).toBe(MAX_TIMER_DELAY)
    expect(ttlRecheckDelay(days90)).toBe(MAX_TIMER_DELAY)
    expect(MAX_TIMER_DELAY).toBe(2_147_483_647)
  })
})

describe('ttlTone', () => {
  it('永久 / 即将过期（0~60）/ 普通', () => {
    expect(ttlTone(-1)).toBe('forever')
    expect(ttlTone(0)).toBe('urgent')
    expect(ttlTone(60)).toBe('urgent')
    expect(ttlTone(61)).toBe('')
    expect(ttlTone(-2)).toBe('')
  })
})

describe('formatBytes', () => {
  it('空值与非法值显示占位符', () => {
    expect(formatBytes(undefined)).toBe('-')
    expect(formatBytes(Number.NaN)).toBe('-')
  })

  it('B / KB / MB 分档', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(8292)).toBe('8.1 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB')
  })
})

describe('prettyJson', () => {
  it('合法对象 JSON 美化缩进', () => {
    expect(prettyJson('{"a":1}')).toEqual({ ok: true, text: '{\n  "a": 1\n}' })
  })

  it('合法数组 JSON 美化缩进', () => {
    expect(prettyJson('[1,2]')).toEqual({ ok: true, text: '[\n  1,\n  2\n]' })
  })

  it('非 JSON 文本原样返回', () => {
    expect(prettyJson('hello')).toEqual({ ok: false, text: 'hello' })
  })

  it('形似 JSON 但解析失败原样返回', () => {
    expect(prettyJson('{"a":')).toEqual({ ok: false, text: '{"a":' })
  })
})

describe('oneLine', () => {
  it('多行文本压成单行', () => {
    expect(oneLine('a\n  b\nc')).toBe('a b c')
  })

  it('超过 max 截断并加省略号', () => {
    const result = oneLine('x'.repeat(200), 160)
    expect(result).toHaveLength(161)
    expect(result.endsWith('…')).toBe(true)
  })

  it('未超长不截断', () => {
    expect(oneLine('abc')).toBe('abc')
  })
})