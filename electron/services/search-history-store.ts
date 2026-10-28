import fs from 'node:fs'
import path from 'node:path'
import type { SearchHistoryEntry, SearchHistoryFile } from '../../shared/types'
import { configFile } from './config-path'

/**
 * 键搜索历史持久化。
 * 落盘位置：<配置目录>/search-history.json（与 connections/settings 同级）
 *
 * 分桶：桶键 `${connectionId}@${db}` —— 键空间是 db 级的，
 * 跨 db 共享补全只会给出当前库不存在的键名。
 *
 * 桶内 LRU 语义 + 上限 30 条：只在「执行查询」时写入，
 * 重复查询提升到最前并累加次数，超限丢弃最旧。
 *
 * 错误策略与 settings-store 一致：读失败回退空历史（补全是增强功能，
 * 历史文件损坏不应拖垮键浏览），写失败仅记日志。
 */

/** 每个桶（连接 @ 库）的历史上限 */
export const SEARCH_HISTORY_LIMIT = 30

function historyFile(): string {
  return configFile('search-history.json')
}

function loadFile(): SearchHistoryFile {
  const file = historyFile()
  if (!fs.existsSync(file)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as SearchHistoryFile
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    /* 逐桶做形状收敛：历史文件可能被手改或来自旧版本 */
    const out: SearchHistoryFile = {}
    for (const [bucket, entries] of Object.entries(raw)) {
      if (!Array.isArray(entries)) continue
      const clean = entries.filter(
        (e): e is SearchHistoryEntry =>
          !!e && typeof e.q === 'string' && e.q.length > 0 && typeof e.count === 'number' && typeof e.at === 'number',
      )
      if (clean.length) out[bucket] = clean.slice(0, SEARCH_HISTORY_LIMIT)
    }
    return out
  } catch (error) {
    console.error('[search-history] 读取失败，按空历史处理:', error)
    return {}
  }
}

function saveFile(data: SearchHistoryFile): void {
  const file = historyFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
  } catch (error) {
    console.error('[search-history] 写入失败:', error)
  }
}

function bucketKey(connId: string, db: number): string {
  return `${connId}@${db}`
}

/** 读取一个桶的历史（最近在前）；桶不存在返回空数组 */
export function getSearchHistory(connId: string, db: number): SearchHistoryEntry[] {
  return loadFile()[bucketKey(connId, db)] ?? []
}

/**
 * 记录一次查询，返回该桶最新列表。
 * LRU：已存在则移到最前并 count+1 / at 刷新；新词插到最前；
 * 超过上限丢弃最旧（数组尾部）。
 */
export function recordSearchHistory(connId: string, db: number, term: string): SearchHistoryEntry[] {
  const q = term.trim()
  if (!q) return getSearchHistory(connId, db)

  const key = bucketKey(connId, db)
  const data = loadFile()
  const bucket = data[key] ?? []
  const now = Date.now()

  const i = bucket.findIndex((e) => e.q === q)
  if (i >= 0) {
    const [hit] = bucket.splice(i, 1)
    bucket.unshift({ q: hit.q, count: hit.count + 1, at: now })
  } else {
    bucket.unshift({ q, count: 1, at: now })
    if (bucket.length > SEARCH_HISTORY_LIMIT) bucket.length = SEARCH_HISTORY_LIMIT
  }
  data[key] = bucket
  saveFile(data)
  return bucket
}

/** 删除单条，返回该桶最新列表 */
export function removeSearchHistory(connId: string, db: number, term: string): SearchHistoryEntry[] {
  const key = bucketKey(connId, db)
  const data = loadFile()
  const bucket = data[key]
  if (bucket) {
    const next = bucket.filter((e) => e.q !== term)
    if (next.length) data[key] = next
    else delete data[key] /* 空桶不留键，文件保持干净 */
    saveFile(data)
    return next
  }
  return []
}

/** 清空一个桶，返回空列表（统一返回形状） */
export function clearSearchHistory(connId: string, db: number): SearchHistoryEntry[] {
  const key = bucketKey(connId, db)
  const data = loadFile()
  if (key in data) {
    delete data[key]
    saveFile(data)
  }
  return []
}

/**
 * 连接被删除时清理其全部桶（所有 db）。
 * 返回被清理的条数，用于日志；找不到该连接的任何历史时为 0。
 */
export function pruneConnectionSearchHistory(connId: string): number {
  const data = loadFile()
  const prefix = `${connId}@`
  let removed = 0
  for (const key of Object.keys(data)) {
    if (key.startsWith(prefix)) {
      removed += data[key].length
      delete data[key]
    }
  }
  if (removed > 0) saveFile(data)
  return removed
}
