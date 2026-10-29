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
/**
 * 回归：全库搜索的结果必须能建出树。
 *
 * 曾经的表现 —— 树形仅用 filteredKeys（只过滤已加载的那一页），
 * 全库搜索命中的键在平铺列表可见、切到树形却完全不显示。
 * 修复方式是把树的数据源也换成"当前列表真正在展示的那份数据"
 * （全库搜索态 = remoteKeys，否则 = filteredKeys）。
 * 这条测试锁定"同一份键集合，平铺与树形覆盖范围一致"这一契约。
 */
describe('buildKeyTree · 全库搜索结果', () => {
  it('散落在不同前缀的命中键都能进树，且每个键都可达', () => {
    // 模拟全库扫描的命中结果：三组不同前缀 + 一个无分隔符的键
    const hits = [item('user:1:profile'), item('user:2:profile'), item('order:2024:01'), item('session'), item('cache:x')]
    const tree = buildKeyTree(hits)

    // 树根按首段分组；有子目录的排在纯叶子前（sortTree 的分组规则），
    // 同组内按自然序 —— 所以 user 在 session 之前
    expect(paths(tree)).toEqual(['cache', 'order', 'user', 'session'])

    // 逐个键在树上都能找到对应的 leaf（不丢键是这次修复的核心）
    const reachable: string[] = []
    const walk = (nodes: ReturnType<typeof buildKeyTree>): void => {
      for (const n of nodes) {
        if (n.leaf) reachable.push(n.leaf.key)
        walk(n.children)
      }
    }
    walk(tree)
    expect(reachable.sort()).toEqual(hits.map((h) => h.key).sort())
  })

  it('命中键数量与树叶子数一致（平铺条目数 = 树叶子数）', () => {
    const hits = [item('a:1'), item('a:2'), item('b:1'), item('c:1:1'), item('c:1:2')]
    const tree = buildKeyTree(hits)
    const countLeaves = (nodes: ReturnType<typeof buildKeyTree>): number =>
      nodes.reduce((sum, n) => sum + (n.leaf ? 1 : 0) + countLeaves(n.children), 0)
    expect(countLeaves(tree)).toBe(hits.length)
  })
})
