import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LuaSaveRequest, LuaScript, LuaScriptsFile } from '../../shared/types'
import { LUA_SCRIPTS_LIMIT, LUA_SCRIPT_MAX_BYTES } from '../../shared/limits'
import { configFile } from './config-path'

/**
 * Lua 脚本片段持久化（全局，不绑定连接）。
 * 落盘：<配置目录>/lua-scripts.json；上限 100 条，单脚本 ≤256KB。
 * 读失败回退空列表，写失败抛错由 IPC 转成错误返回。
 */

function scriptsFile(): string {
  return configFile('lua-scripts.json')
}

function loadFile(): LuaScriptsFile {
  const file = scriptsFile()
  if (!fs.existsSync(file)) return { version: 1, scripts: [] }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<LuaScriptsFile>
    const scripts = Array.isArray(raw.scripts)
      ? raw.scripts.filter(
          (item): item is LuaScript =>
            !!item &&
            typeof item.id === 'string' &&
            typeof item.name === 'string' &&
            typeof item.script === 'string' &&
            typeof item.createdAt === 'number' &&
            typeof item.updatedAt === 'number',
        )
      : []
    return { version: 1, scripts: scripts.slice(0, LUA_SCRIPTS_LIMIT) }
  } catch (error) {
    console.error('[lua-scripts] 读取失败，按空列表处理:', error)
    return { version: 1, scripts: [] }
  }
}

function saveFile(data: LuaScriptsFile): void {
  const file = scriptsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
}

export function listLuaScripts(): LuaScript[] {
  return loadFile().scripts
}

export function saveLuaScript(request: LuaSaveRequest): LuaScript[] {
  const name = request.name.trim()
  if (!name) throw new Error('script name is required')
  if (new TextEncoder().encode(request.script).length > LUA_SCRIPT_MAX_BYTES) {
    throw new Error('script is too large')
  }

  const data = loadFile()
  const now = Date.now()
  const current = request.id ? data.scripts.find((item) => item.id === request.id) : null
  if (current) {
    const updated: LuaScript = {
      ...current,
      name,
      script: request.script,
      updatedAt: now,
    }
    data.scripts = [updated, ...data.scripts.filter((item) => item.id !== current.id)]
  } else {
    if (data.scripts.length >= LUA_SCRIPTS_LIMIT) throw new Error('too many scripts')
    data.scripts.unshift({
      id: randomUUID(),
      name,
      script: request.script,
      createdAt: now,
      updatedAt: now,
    })
  }
  saveFile(data)
  return data.scripts
}

/** 批量删除共用一次读写，避免逐条删除时反复重写文件 */
export function removeLuaScripts(ids: string[]): LuaScript[] {
  const remove = new Set(ids)
  if (!remove.size) return loadFile().scripts
  const data = loadFile()
  data.scripts = data.scripts.filter((item) => !remove.has(item.id))
  saveFile(data)
  return data.scripts
}

export function removeLuaScript(id: string): LuaScript[] {
  return removeLuaScripts([id])
}
