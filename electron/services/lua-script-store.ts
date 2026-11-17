import fs from 'node:fs'
import path from 'node:path'
import { t } from '@shared/i18n'
import type { LuaSaveRequest, LuaScript } from '../../shared/types'
import { LUA_SCRIPTS_LIMIT, LUA_SCRIPT_MAX_BYTES } from '../../shared/limits'
import { configFile, scriptsDir } from './config-path'

/**
 * Lua 脚本片段持久化（全局，不绑定连接）。
 * 每个脚本一个 .lua 文件，默认放在程序目录的 scripts/；程序目录不可写时回退配置目录。
 * 上限 100 条，单脚本 ≤256KB。
 */

const EXT = '.lua'
const LEGACY_FILE = 'lua-scripts.json'
const MAX_NAME = 80
const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function luaDir(): string {
  const dir = scriptsDir()
  fs.mkdirSync(dir, { recursive: true })
  migrateLegacy(dir)
  return dir
}

function normalizeName(raw: string): string {
  const name = raw.trim()
  if (!name) throw new Error(t('luaConsole.nameRequired'))
  if (name.length > MAX_NAME) throw new Error(t('luaConsole.nameTooLong'))
  if (INVALID_NAME.test(name) || /[. ]$/.test(name) || RESERVED_NAME.test(name)) {
    throw new Error(t('luaConsole.nameInvalid'))
  }
  return name
}

/** 文件名大小写不敏感比较，避免 Linux/macOS 上出现仅大小写不同的同名脚本 */
function findFile(dir: string, fileName: string, ignore?: string): boolean {
  const target = fileName.toLowerCase()
  return fs.readdirSync(dir).some(
    (entry) => entry !== ignore && entry.toLowerCase() === target,
  )
}

function currentFile(dir: string, id: string): string | null {
  if (!id || id.includes('/') || id.includes('\\') || !id.toLowerCase().endsWith(EXT)) {
    return null
  }
  return path.join(dir, id)
}

function countScripts(dir: string): number {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(EXT)).length
}

function readScripts(): LuaScript[] {
  const dir = luaDir()
  const scripts: LuaScript[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(EXT)) continue
    const file = path.join(dir, entry.name)
    try {
      const stat = fs.statSync(file)
      if (stat.size > LUA_SCRIPT_MAX_BYTES) {
        console.warn(`[lua-scripts] 跳过超过大小上限的脚本: ${entry.name}`)
        continue
      }
      scripts.push({
        id: entry.name,
        name: entry.name.slice(0, -EXT.length),
        script: fs.readFileSync(file, 'utf-8'),
        createdAt: stat.birthtimeMs || stat.ctimeMs,
        updatedAt: stat.mtimeMs,
      })
    } catch (error) {
      console.warn(`[lua-scripts] 读取失败，跳过 ${entry.name}:`, error)
    }
  }
  scripts.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
  return scripts.slice(0, LUA_SCRIPTS_LIMIT)
}

/** 保存后把目标脚本提到最前，避免同一时间戳下排序不稳定导致选中项跳走 */
function withFirst(scripts: LuaScript[], id: string): LuaScript[] {
  const first = scripts.find((item) => item.id === id)
  return first ? [first, ...scripts.filter((item) => item.id !== id)] : scripts
}

function legacyName(raw: string): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, MAX_NAME)
  if (!cleaned) return 'script'
  return RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned
}

function uniqueName(dir: string, base: string): string {
  let name = base
  let index = 2
  while (findFile(dir, `${name}${EXT}`)) name = `${base} (${index++})`
  return name
}

/** 旧版 scripts 存在 lua-scripts.json 里；首次访问时导入为 .lua 文件并改名留档 */
function migrateLegacy(dir: string): void {
  const legacy = configFile(LEGACY_FILE)
  if (!fs.existsSync(legacy)) return
  try {
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf-8')) as { scripts?: unknown }
    const items = Array.isArray(raw.scripts) ? raw.scripts : []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const { name, script } = item as { name?: unknown; script?: unknown }
      if (typeof name !== 'string' || typeof script !== 'string') continue
      if (Buffer.byteLength(script, 'utf-8') > LUA_SCRIPT_MAX_BYTES) continue
      const fileName = `${uniqueName(dir, legacyName(name))}${EXT}`
      fs.writeFileSync(path.join(dir, fileName), script, 'utf-8')
    }
    fs.rmSync(`${legacy}.migrated`, { force: true })
    fs.renameSync(legacy, `${legacy}.migrated`)
  } catch (error) {
    console.error('[lua-scripts] 旧版 JSON 迁移失败，保留原文件:', error)
  }
}

export function listLuaScripts(): LuaScript[] {
  return readScripts()
}

export function saveLuaScript(request: LuaSaveRequest): LuaScript[] {
  const name = normalizeName(request.name)
  if (Buffer.byteLength(request.script, 'utf-8') > LUA_SCRIPT_MAX_BYTES) {
    throw new Error(t('luaConsole.scriptTooLarge'))
  }

  const dir = luaDir()
  const fileName = `${name}${EXT}`
  const target = path.join(dir, fileName)
  const current = request.id ? currentFile(dir, request.id) : null
  const currentName = current ? path.basename(current) : undefined
  const existing = current ? fs.existsSync(current) : false

  if (findFile(dir, fileName, currentName)) {
    throw new Error(t('luaConsole.nameExists'))
  }

  if (existing) {
    if (currentName !== fileName) fs.renameSync(current as string, target)
    fs.writeFileSync(target, request.script, 'utf-8')
  } else {
    if (countScripts(dir) >= LUA_SCRIPTS_LIMIT) throw new Error(t('luaConsole.tooManyScripts'))
    fs.writeFileSync(target, request.script, 'utf-8')
  }

  return withFirst(readScripts(), fileName)
}

/** 批量删除逐个移除文件；不存在的 id 直接忽略 */
export function removeLuaScripts(ids: string[]): LuaScript[] {
  const dir = luaDir()
  for (const id of ids) {
    const file = currentFile(dir, id)
    if (file) fs.rmSync(file, { force: true })
  }
  return readScripts()
}

export function removeLuaScript(id: string): LuaScript[] {
  return removeLuaScripts([id])
}
