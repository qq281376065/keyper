import { describe, expect, it } from 'vitest'
import { typeAbbr, typeLabel } from '@/utils/typeLabel'

describe('typeAbbr', () => {
  it('七种类型的固定缩写', () => {
    expect(typeAbbr('string')).toBe('S')
    expect(typeAbbr('hash')).toBe('H')
    expect(typeAbbr('list')).toBe('L')
    expect(typeAbbr('set')).toBe('E')
    expect(typeAbbr('zset')).toBe('Z')
    expect(typeAbbr('stream')).toBe('X')
    expect(typeAbbr('none')).toBe('?')
  })

  it('空值返回问号', () => {
    expect(typeAbbr(undefined)).toBe('?')
    expect(typeAbbr('')).toBe('?')
  })

  it('未知类型降级为首字母大写（服务端新增类型不出现空白方块）', () => {
    expect(typeAbbr('future-type')).toBe('F')
  })
})

describe('typeLabel', () => {
  it('已知类型给完整中文名称', () => {
    expect(typeLabel('string')).toBe('string · 字符串')
    expect(typeLabel('zset')).toBe('zset · 有序集合')
    expect(typeLabel('none')).toBe('键不存在')
  })

  it('空值与未知类型', () => {
    expect(typeLabel(undefined)).toBe('未知类型')
    expect(typeLabel('future-type')).toBe('future-type')
  })
})