import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings } from '../../shared/types'
import { configFile } from './config-path'

/**
 * 应用设置持久化。
 * 落盘位置：<配置目录>/settings.json
 * 配置目录默认是「程序目录/config」（便携），不可写时回退 userData，见 config-path.ts
 *
 * 默认值与当前界面现状保持一致，避免首次升级后视觉突变。
 */
export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  uiFont: 'system',
  monoFont: 'jetbrains-mono',
  density: 'compact',
  pageSize: 200,
  keySeparator: ':',
  confirmDelete: true,
  logRetentionDays: 30,
  /* 界面状态记忆：首次启动用保守默认，不猜测用户偏好 */
  theme: 'system',
  viewMode: 'tree',
  cliCollapsed: true,
  sidebarCollapsed: false,
  keyBrowserWidth: 420,
  lastConnectionId: null,
  lastDb: 0,
  expandedPaths: {},
}

function settingsFile(): string {
  return configFile('settings.json')
}

export function loadSettings(): AppSettings {
  const file = settingsFile()
  if (!fs.existsSync(file)) return { ...DEFAULT_SETTINGS }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<AppSettings>
    return { ...DEFAULT_SETTINGS, ...raw }
  } catch (error) {
    console.error('[settings] 读取失败，回退默认值:', error)
    return { ...DEFAULT_SETTINGS }
  }
}

/** 合并写入并做范围收敛，避免越界配置落盘 */
export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged: AppSettings = { ...loadSettings(), ...patch }

  merged.fontSize = Math.min(Math.max(Math.round(merged.fontSize) || DEFAULT_SETTINGS.fontSize, 10), 20)
  merged.pageSize = Math.min(Math.max(merged.pageSize || DEFAULT_SETTINGS.pageSize, 20), 5000)
  merged.logRetentionDays = Math.min(Math.max(merged.logRetentionDays || 30, 1), 365)
  if (!merged.keySeparator) merged.keySeparator = DEFAULT_SETTINGS.keySeparator

  const file = settingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}
