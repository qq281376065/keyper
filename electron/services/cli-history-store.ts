import fs from 'node:fs'
import path from 'node:path'
import type { CliHistoryFile } from '../../shared/types'
import { CLI_HISTORY_LIMIT } from '../../shared/limits'
import { configFile } from './config-path'

/**
 * CLI 历史持久化。
 * 落盘位置：<配置目录>/cli-history.json（与 search-history / favorites 同级）。
 *
 * 按连接分桶：命令会 SELECT 切库，按连接比按库更符合直觉；
 * 上限 200 条，重复命令（大小写不敏感）提升到最前。
 * 读失败回退空历史、写失败仅记日志 —— 补全是增强能力，不拖垮控制台。
 */

function historyFile(): string {
  return configFile('cli-history.json')
}

function loadFile(): CliHistoryFile {
  const file = historyFile()
  if (!fs.existsSync(file)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as CliHistoryFile
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: CliHistoryFile = {}
    for (const [bucket, entries] of Object.entries(raw)) {
      if (!Array.isArray(entries)) continue
      const clean = entries
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .slice(0, CLI_HISTORY_LIMIT)
      if (clean.length) out[bucket] = clean
    }
    return out
  } catch (error) {
    console.error('[cli-history] 读取失败，按空历史处理:', error)
    return {}
  }
}

function saveFile(data: CliHistoryFile): void {
  const file = historyFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
  } catch (error) {
    console.error('[cli-history] 写入失败:', error)
  }
}

export function getCliHistory(connId: string): string[] {
  return loadFile()[connId] ?? []
}

/** 记录一次执行，返回该连接最新列表（新的在前） */
export function recordCliHistory(connId: string, command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed) return getCliHistory(connId)

  const data = loadFile()
  const bucket = data[connId] ?? []
  const lower = trimmed.toLowerCase()
  const index = bucket.findIndex((entry) => entry.toLowerCase() === lower)
  if (index >= 0) bucket.splice(index, 1)
  bucket.unshift(trimmed)
  if (bucket.length > CLI_HISTORY_LIMIT) bucket.length = CLI_HISTORY_LIMIT
  data[connId] = bucket
  saveFile(data)
  return [...bucket]
}

export function clearCliHistory(connId: string): string[] {
  const data = loadFile()
  delete data[connId]
  saveFile(data)
  return []
}

/** 连接删除时清理该连接的 CLI 历史，返回清理条数 */
export function pruneConnectionCliHistory(connId: string): number {
  const data = loadFile()
  const bucket = data[connId]
  if (!bucket) return 0
  delete data[connId]
  saveFile(data)
  return bucket.length
}
