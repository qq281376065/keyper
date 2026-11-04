import fs from 'node:fs'
import path from 'node:path'
import type { FavoriteEntry, FavoritesFile } from '../../shared/types'
import { FAVORITES_LIMIT } from '../../shared/limits'
import { configFile } from './config-path'

/**
 * 键收藏持久化。
 * 落盘位置：<配置目录>/favorites.json（与 search-history.json 同级）。
 *
 * 按连接分桶：键空间属于连接，跨连接共享收藏只会得到一堆连不回去的键名。
 * 条目内记录 db，因为收藏的键不一定在当前库；点击时先切库再选中。
 *
 * 错误策略与 search-history-store 一致：读失败回退空列表，
 * 写失败仅记日志 —— 收藏是增强能力，文件损坏不应拖垮键浏览。
 */

function favoritesFile(): string {
  return configFile('favorites.json')
}

function loadFile(): FavoritesFile {
  const file = favoritesFile()
  if (!fs.existsSync(file)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as FavoritesFile
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: FavoritesFile = {}
    for (const [bucket, entries] of Object.entries(raw)) {
      if (!Array.isArray(entries)) continue
      const seen = new Set<string>()
      const clean: FavoriteEntry[] = []
      for (const entry of entries) {
        if (
          !entry ||
          typeof entry.key !== 'string' ||
          !entry.key ||
          typeof entry.db !== 'number' ||
          !Number.isInteger(entry.db) ||
          entry.db < 0 ||
          typeof entry.at !== 'number'
        ) {
          continue
        }
        const id = `${entry.db}\u0000${entry.key}`
        if (seen.has(id)) continue
        seen.add(id)
        clean.push({ key: entry.key, db: entry.db, at: entry.at })
        if (clean.length >= FAVORITES_LIMIT) break
      }
      if (clean.length) out[bucket] = clean
    }
    return out
  } catch (error) {
    console.error('[favorites] 读取失败，按空收藏处理:', error)
    return {}
  }
}

function saveFile(data: FavoritesFile): void {
  const file = favoritesFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
  } catch (error) {
    console.error('[favorites] 写入失败:', error)
  }
}

export function getFavorites(connId: string): FavoriteEntry[] {
  return loadFile()[connId] ?? []
}

/** 已收藏则移除，未收藏则插到最前；返回该连接最新列表 */
export function toggleFavorite(connId: string, db: number, key: string): FavoriteEntry[] {
  const target = key.trim()
  if (!target) return getFavorites(connId)

  const data = loadFile()
  const bucket = data[connId] ?? []
  const index = bucket.findIndex((entry) => entry.key === target && entry.db === db)
  if (index >= 0) {
    bucket.splice(index, 1)
  } else {
    bucket.unshift({ key: target, db, at: Date.now() })
    if (bucket.length > FAVORITES_LIMIT) bucket.length = FAVORITES_LIMIT
  }

  if (bucket.length) data[connId] = bucket
  else delete data[connId]
  saveFile(data)
  return [...bucket]
}

export function removeFavorite(connId: string, db: number, key: string): FavoriteEntry[] {
  const data = loadFile()
  const bucket = (data[connId] ?? []).filter((entry) => !(entry.key === key && entry.db === db))
  if (bucket.length) data[connId] = bucket
  else delete data[connId]
  saveFile(data)
  return [...bucket]
}

export function clearFavorites(connId: string): FavoriteEntry[] {
  const data = loadFile()
  delete data[connId]
  saveFile(data)
  return []
}

/** 连接删除时清空该连接的收藏桶，返回清理条数 */
export function pruneConnectionFavorites(connId: string): number {
  const data = loadFile()
  const bucket = data[connId]
  if (!bucket) return 0
  delete data[connId]
  saveFile(data)
  return bucket.length
}
