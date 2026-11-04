import { describe, expect, it } from 'vitest'
import { buildCliSuggestions } from '@/utils/cliSuggest'

describe('buildCliSuggestions', () => {
  it('空输入给顶层命令', () => {
    const items = buildCliSuggestions('', [], 5)
    expect(items).toHaveLength(5)
    expect(items.every((item) => item.kind === 'command')).toBe(true)
    expect(items.every((item) => !item.label.includes(' '))).toBe(true)
  })

  it('按前缀匹配命令，采纳带尾随空格', () => {
    const items = buildCliSuggestions('hg', [])
    const hgetall = items.find((item) => item.label === 'HGETALL')
    expect(hgetall?.value).toBe('HGETALL ')
  })

  it('容器命令后给子命令', () => {
    const items = buildCliSuggestions('client ', [])
    expect(items.some((item) => item.kind === 'subcommand' && item.label === 'LIST')).toBe(true)
    expect(items.every((item) => item.value.startsWith('CLIENT '))).toBe(true)
  })

  it('参数位置给已加载键名', () => {
    const items = buildCliSuggestions('GET us', ['user:1', 'user:2', 'order:1'])
    expect(items.map((item) => item.label)).toEqual(['user:1', 'user:2'])
    expect(items[0]?.value).toBe('GET user:1 ')
  })

  it('键名带空格时自动加引号', () => {
    const items = buildCliSuggestions('GET hello', ['hello world'])
    expect(items[0]?.value).toBe('GET "hello world" ')
  })

  it('容器命令第二个参数仍可给键名', () => {
    const items = buildCliSuggestions('CLIENT us', ['user:1'])
    expect(items[0]?.kind).toBe('key')
  })
})
