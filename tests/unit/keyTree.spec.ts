import { describe, expect, it } from 'vitest'
import type { RedisKeyItem } from '@shared/types'
import { buildKeyTree, collectParents, collectParentsBelow } from '@/utils/keyTree'

function item(key: string, type: RedisKeyItem['type'] = 'string'): RedisKeyItem {
  return { key, type, ttl: -1 }
}

const paths = (nodes: { path: string }[]): string[] => nodes.map((n) => n.path)

describe('buildKeyTree', () => {
  it('按键名逐段建层', () => {
    const tree = buildKeyTree([item('a:aa:1'), item('a:aa:2'), item('a:bb')])
    expect(paths(tree)).toEqual(['a'])
    expect(paths(tree[0].children)).toEqual(['a:aa', 'a:bb'])
    expect(paths(tree[0].children[0].children)).toEqual(['a:aa:1', 'a:aa:2'])
  })

  it('前缀本身也是键时，节点同时持有 leaf 与 children', () => {
    const tree = buildKeyTree([item('a:aa'), item('a:aa:1')])
    const aa = tree[0].children[0]
    expect(aa.leaf?.key).toBe('a:aa')
    expect(paths(aa.children)).toEqual(['a:aa:1'])
  })

  it('含空段（连续/首尾分隔符）的键退化为根级节点', () => {
    const tree = buildKeyTree([item('a::1'), item('x:')])
    expect(paths(tree)).toEqual(['a::1', 'x:'])
    expect(tree.every((n) => n.children.length === 0)).toBe(true)
  })

  it('目录节点排在叶子前，同组内自然序（a2 < a10）', () => {
    const tree = buildKeyTree([item('a:10'), item('b'), item('a:2'), item('aa')])
    expect(tree.map((n) => n.label)).toEqual(['a', 'aa', 'b'])
    expect(tree[0].children.map((n) => n.label)).toEqual(['2', '10'])
  })

  it('leafCount 聚合子树内的真实键数（含自身是键的前缀节点）', () => {
    const tree = buildKeyTree([item('a:aa:1'), item('a:aa:2'), item('a:bb'), item('a:aa')])
    expect(tree[0].leafCount).toBe(4)
    expect(tree[0].children[0].leafCount).toBe(3)
    expect(tree[0].children[1].leafCount).toBe(1)
  })

  it('支持自定义分隔符', () => {
    const tree = buildKeyTree([item('a-b')], '-')
    expect(tree[0].label).toBe('a')
    expect(tree[0].children[0].path).toBe('a-b')
  })
})

describe('collectParents / collectParentsBelow', () => {
  const tree = buildKeyTree([item('a:aa:1'), item('a:bb'), item('c')])

  it('collectParents 收集全部目录路径（叶子不收）', () => {
    expect(collectParents(tree)).toEqual(['a', 'a:aa'])
  })

  it('collectParentsBelow(1) 收集全部目录（顶层深度为 1）', () => {
    expect(collectParentsBelow(tree, 1)).toEqual(['a', 'a:aa'])
  })

  it('collectParentsBelow(2) 只收集第 2 层及以下', () => {
    expect(collectParentsBelow(tree, 2)).toEqual(['a:aa'])
  })
})