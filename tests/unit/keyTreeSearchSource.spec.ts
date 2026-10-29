import { describe, expect, it } from 'vitest'
import type { RedisKeyItem } from '@shared/types'
import { buildKeyTree } from '@/utils/keyTree'

/**
 * 回归：树形与平铺必须吃同一份数据。
 *
 * 原 bug —— KeyBrowser 里平铺用 displayKeys（全库搜索态 = remoteKeys），
 * 树形却固定用 filteredKeys（只过滤已加载的一页）。全库搜到但没被加载
 * 进当前页的键，平铺可见、树形不可见。
 *
 * 这里不复刻组件，而是锁定那条数据契约的两个输入：
 *   ① remoteKeys（全库结果）建出的树，必须覆盖全部命中键；
 *   ② 已被加载的 filteredKeys 建出的树，确实会漏掉未加载的键
 *      —— 用它解释"为什么当初会丢"，也防止有人再把树改回 filteredKeys。
 */
function item(key: string): RedisKeyItem {
  return { key, type: 'string', ttl: -1 }
}

const leavesOf = (nodes: ReturnType<typeof buildKeyTree>): string[] => {
  const out: string[] = []
  const walk = (ns: ReturnType<typeof buildKeyTree>): void => {
    for (const n of ns) {
      if (n.leaf) out.push(n.leaf.key)
      walk(n.children)
    }
  }
  walk(nodes)
  return out.sort()
}

describe('树形数据源契约', () => {
  /** 当前已加载的一页（模拟分页只加载了一部分） */
  const loadedPage = [item('user:1:name'), item('user:1:age')]
  /** 全库扫描额外命中的键（不在已加载页里） */
  const extraHits = [item('order:9:total'), item('cache:hot')]
  const remoteKeys = [...loadedPage, ...extraHits]

  it('用全库结果建树时，所有命中键都可达', () => {
    expect(leavesOf(buildKeyTree(remoteKeys))).toEqual(remoteKeys.map((k) => k.key).sort())
  })

  it('只用已加载页建树会漏掉全库命中（即原 bug 的成因）', () => {
    const fromLoaded = leavesOf(buildKeyTree(loadedPage))
    const missing = extraHits.map((k) => k.key).filter((k) => !fromLoaded.includes(k))
    expect(missing).toEqual(['order:9:total', 'cache:hot'])
  })
})
