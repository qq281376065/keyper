import { describe, expect, it } from 'vitest'
import { compareVersion } from '@shared/version'

/**
 * 版本比较决定"要不要提示有新版"，比错会持续骚扰用户或永远不提示，
 * 这里把常见 tag 形态全部固定住。
 */
describe('compareVersion', () => {
  it('按数字段比较而不是字符串比较', () => {
    // 字符串比较会认为 "1.10.0" < "1.9.0"，这是最典型的坑
    expect(compareVersion('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersion('1.9.0', '1.10.0')).toBe(-1)
  })

  it('段数不同时短的一方按 0 补齐', () => {
    expect(compareVersion('1.2', '1.2.0')).toBe(0)
    expect(compareVersion('1.2.1', '1.2')).toBe(1)
  })

  it('忽略 v 前缀', () => {
    expect(compareVersion('v1.1.0', '1.0.0')).toBe(1)
    expect(compareVersion('v1.0.0', '1.0.0')).toBe(0)
  })

  it('预发布标记不参与主序比较', () => {
    expect(compareVersion('1.1.0-beta.2', '1.1.0')).toBe(0)
  })

  it('相同版本返回 0', () => {
    expect(compareVersion('1.0.0', '1.0.0')).toBe(0)
  })
})
