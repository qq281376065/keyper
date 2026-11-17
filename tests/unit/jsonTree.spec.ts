import { describe, expect, it } from 'vitest'
import {
  buildJsonTree,
  collectStructPaths,
  TREE_FOLD_THRESHOLD,
  TREE_FOLD_PREFIX,
} from '@/utils/jsonTree'

describe('buildJsonTree · JSON 树模型', () => {
  it('对象根：标题带计数，子节点按插入序', () => {
    const r = buildJsonTree('{"name":"keyper","version":5,"ok":true}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.root.kind).toBe('object')
    expect(r.root.structLabel).toBe('$  {Object:3}')
    expect(r.root.children!.map((c) => c.key)).toEqual(['name', 'version', 'ok'])
    expect(r.root.children![0].leafText).toBe('"keyper"')
    expect(r.root.children![1].kind).toBe('int')
    expect(r.root.children![2].kind).toBe('bool')
  })

  it('数组根：子节点键为 [i]，路径为 $[i]', () => {
    const r = buildJsonTree('[1,"two",null]')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.root.kind).toBe('array')
    expect(r.root.structLabel).toBe('$  [Array:3]')
    expect(r.root.children!.map((c) => c.path)).toEqual(['$[0]', '$[1]', '$[2]'])
    expect(r.root.children![2].kind).toBe('null')
    expect(r.root.children![2].leafText).toBe('null')
  })

  it('嵌套结构：路径逐层拼接，深度与统计正确', () => {
    const r = buildJsonTree('{"a":{"b":[10,20]},"c":1.5}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const a = r.root.children![0]
    expect(a.path).toBe('$.a')
    const b = a.children![0]
    expect(b.path).toBe('$.a.b')
    expect(b.children![1].path).toBe('$.a.b[1]')
    expect(b.children![1].depth).toBe(3)
    expect(r.root.children![1].kind).toBe('float')
    /* 节点数：$ + a + b + 10 + 20 + c = 6；最大深度 3 */
    expect(r.stats).toEqual({ nodes: 6, maxDepth: 3 })
  })

  it('长字符串截断：leafText 为前缀+省略号，fullText 保留完整值', () => {
    const long = 'x'.repeat(TREE_FOLD_THRESHOLD + 50)
    const r = buildJsonTree(JSON.stringify({ payload: long }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const leaf = r.root.children![0]
    expect(leaf.leafText).toBe(`"${'x'.repeat(TREE_FOLD_PREFIX)}…"`)
    expect(leaf.fullText).toBe(`"${long}"`)
  })

  it('短字符串不截断（fullText 为 null）', () => {
    const r = buildJsonTree('{"s":"short"}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.root.children![0].fullText).toBeNull()
  })

  it('控制字符替换为空格（含换行/制表符/\\u007f）', () => {
    const r = buildJsonTree('{"s":"a\\nb\\tc\\u007fd"}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.root.children![0].leafText).toBe('"a b c d"')
  })

  it('非 JSON 文本拒绝（not-json）', () => {
    expect(buildJsonTree('hello world')).toEqual({ ok: false, error: 'not-json' })
    expect(buildJsonTree('{broken')).toEqual({ ok: false, error: 'not-json' })
    expect(buildJsonTree('')).toEqual({ ok: false, error: 'not-json' })
  })

  it('标量 JSON 拒绝（not-structured）：数字/字符串/布尔/null 根', () => {
    expect(buildJsonTree('42')).toEqual({ ok: false, error: 'not-json' })
    expect(buildJsonTree('"str"')).toEqual({ ok: false, error: 'not-json' })
    /* 以 { 开头但解析出标量的构造不存在；null/true 不以 {/[ 开头归 not-json */
    expect(buildJsonTree('null')).toEqual({ ok: false, error: 'not-json' })
  })

  it('空对象/空数组：结构节点无子节点，计数 0', () => {
    const obj = buildJsonTree('{}')
    expect(obj.ok).toBe(true)
    if (obj.ok) {
      expect(obj.root.children).toEqual([])
      expect(obj.root.structLabel).toBe('$  {Object:0}')
      expect(obj.stats).toEqual({ nodes: 1, maxDepth: 0 })
    }
    const arr = buildJsonTree('[]')
    expect(arr.ok).toBe(true)
    if (arr.ok) expect(arr.root.structLabel).toBe('$  [Array:0]')
  })

  it('collectStructPaths 收集全部结构节点（叶子不收）', () => {
    const r = buildJsonTree('{"a":{"b":1},"c":[2]}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(collectStructPaths(r.root).sort()).toEqual(['$', '$.a', '$.c'].sort())
  })

  it('整数与浮点区分（int / float 语义色不同）', () => {
    const r = buildJsonTree('{"i":7,"f":7.5,"neg":-3}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.root.children!.map((c) => c.kind)).toEqual(['int', 'float', 'int'])
  })
})