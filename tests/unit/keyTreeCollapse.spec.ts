import { describe, expect, it } from 'vitest'
import type { RedisKeyItem } from '@shared/types'
import { buildKeyTree, collectParents } from '@/utils/keyTree'

function item(key: string): RedisKeyItem {
  return { key, type: 'string', ttl: -1 }
}

/**
 * 键树折叠状态的跨数据集隔离单测。
 *
 * 对应缺陷（已修）：切标签后目录莫名处于展开态。
 *
 * 根因是「折叠集存的是路径字符串」，而不同连接/库的路径可能同形
 * （两台实例上都有 HALLOWEEN、mq 这类目录名）。KeyBrowser 原来只在
 * `keysDataset === datasetKey`（数据确已切换到新数据集）时才
 * restoreExpanded，切标签的那一瞬数据还是旧的 → 提前 return →
 * collapsed 里留着上一个数据集的形态；等新数据到位，同名路径
 * 不在 collapsed 中，于是显示为展开。
 *
 * 修法是「datasetKey 一变就先把 collapsed 清空，再由 restoreExpanded
 * 按本数据集存档重建」。这里锁定该修法依赖的两个纯函数语义，
 * 防止将来改 keyTree 时把隔离性破坏掉。
 */

const SEP = ':'

describe('折叠状态 · 数据集隔离', () => {
  /** 两台「实例」的键集合：目录名刻意同形，子键不同 */
  const connA = ['HALLOWEEN:task', 'HALLOWEEN:config', 'mq:queue', 'LUCKYSTAR']
  const connB = ['HALLOWEEN:other', 'HALLOWEEN:second', 'mq:dead', 'SIYECAO:x']

  it('两个数据集的目录路径集合同形（这正是串台的成因）', () => {
    const pa = collectParents(buildKeyTree(connA.map(item), SEP))
    const pb = collectParents(buildKeyTree(connB.map(item), SEP))
    expect(pa.sort()).toEqual(['HALLOWEEN', 'mq'].sort())
    expect(pb.sort()).toEqual(['HALLOWEEN', 'mq', 'SIYECAO'].sort())
    /* 交集非空 —— 共享路径就是「上一个数据集的折叠形态会漏到新数据集」的原因 */
    expect(pa.filter((p) => pb.includes(p)).length).toBe(2)
  })

  it('用 A 的展开路径去构建 B 的折叠集会漏判（旧实现的问题形态）', () => {
    const treeB = buildKeyTree(connB.map(item), SEP)
    const allB = collectParents(treeB)
    const expandedA = ['HALLOWEEN'] // A 里展开了 HALLOWEEN
    const collapsedB = new Set(allB.filter((p) => !expandedA.includes(p)))
    /* 共享路径 HALLOWEEN 在 B 里被误判为「展开」，而用户从没在 B 上展开过它 */
    expect(collapsedB.has('HALLOWEEN')).toBe(false)
    expect(collapsedB.has('SIYECAO')).toBe(true)
  })

  it('清空折叠集后再按本数据集存档重建，得到正确终态', () => {
    const treeB = buildKeyTree(connB.map(item), SEP)
    const allB = collectParents(treeB)
    /* 修复后的流程：先清空，再用 B 自己的存档（空存档 = 全部折叠）重建 */
    const savedB: string[] = []
    const collapsed = new Set(allB.filter((p) => !savedB.includes(p)))
    expect(collapsed.size).toBe(allB.length) // 全部目录都在折叠集里 = 全折叠
    expect([...collapsed].sort()).toEqual(['HALLOWEEN', 'SIYECAO', 'mq'])
  })

  it('本数据集有展开存档时只展开存档里的目录', () => {
    const treeB = buildKeyTree(connB.map(item), SEP)
    const allB = collectParents(treeB)
    const savedB = ['mq']
    const collapsed = new Set(allB.filter((p) => !savedB.includes(p)))
    expect(collapsed.has('mq')).toBe(false) // 展开
    expect(collapsed.has('HALLOWEEN')).toBe(true) // 折叠
    expect(collapsed.has('SIYECAO')).toBe(true) // 折叠
  })
})
