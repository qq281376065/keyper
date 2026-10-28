import fs from 'node:fs'
import path from 'node:path'
import { app, shell } from 'electron'
import type { ErrorReport, LogEntry, LogFileInfo, LogQuery } from '../../shared/types'
import { loadSettings } from './settings-store'
import { configDir } from './config-path'

/**
 * 手动操作日志。
 *
 * 存储：<配置目录>/logs/yyyymmdd.log（便携模式下即 程序目录/config/logs）（每天一个文件，UTF-8，单行一条，便于 grep）
 * 行格式：时间 | 连接 | 操作 | 详情 | 结果 (耗时)
 * 保留：按设置中的 logRetentionDays（默认 30 天）自动清理
 *
 * 只记录用户显式触发的操作（写命令、CLI、连接与配置变更），
 * 后台自动刷新等操作不经过 IPC，因此不会进入日志。
 */

const FILE_PATTERN = /^(\d{4})(\d{2})(\d{2})\.log$/
/** 单次读取上限，避免超大日志把界面拖死 */
const MAX_ENTRIES = 5000

export function logDir(): string {
  return path.join(configDir(), 'logs')
}

function ensureDir(): void {
  fs.mkdirSync(logDir(), { recursive: true })
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0')
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

function timeText(timestamp: number): string {
  const date = new Date(timestamp)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  )
}

/** 字段内的换行与竖线会破坏行结构，统一替换为空格 */
function sanitize(text: string): string {
  return String(text ?? '').replace(/[\r\n|]+/g, ' ').trim()
}

function formatLine(entry: LogEntry): string {
  const status = entry.ok ? 'OK' : 'FAIL'
  const cost = entry.costMs != null ? ` (${entry.costMs}ms)` : ''
  return [
    timeText(entry.timestamp),
    sanitize(entry.connectionName || '-'),
    sanitize(entry.action),
    sanitize(entry.detail),
    `${status} ${sanitize(entry.result)}${cost}`,
  ].join(' | ')
}

function parseLine(line: string): LogEntry | null {
  const parts = line.split(' | ')
  if (parts.length < 5) return null

  const [time, connectionName, action, detail] = parts
  const tail = parts.slice(4).join(' | ')
  const stamp = Date.parse(time.replace(' ', 'T'))
  const costMatched = /\((\d+)ms\)\s*$/.exec(tail)

  return {
    timestamp: Number.isNaN(stamp) ? 0 : stamp,
    connectionId: '',
    connectionName,
    action,
    detail,
    ok: tail.startsWith('OK'),
    result: tail.replace(/^(OK|FAIL)\s*/, '').replace(/\s*\(\d+ms\)\s*$/, ''),
    costMs: costMatched ? Number(costMatched[1]) : undefined,
  }
}

let lastPruneDay = ''

/** 追加一条日志；每天首次写入时顺带清理过期文件 */
export function appendLog(entry: LogEntry): void {
  try {
    ensureDir()
    const today = dateKey(new Date())
    if (lastPruneDay !== today) {
      lastPruneDay = today
      pruneOldLogs()
    }
    const file = path.join(logDir(), `${dateKey(new Date(entry.timestamp))}.log`)
    fs.appendFileSync(file, `${formatLine(entry)}\n`, 'utf-8')
  } catch (error) {
    console.error('[log] 写入失败:', error)
  }
}

/** 删除超出保留天数的日志文件，返回删除数量 */
export function pruneOldLogs(): number {
  const retention = loadSettings().logRetentionDays || 30
  const cutoff = Date.now() - retention * 86400_000
  let removed = 0

  try {
    ensureDir()
    for (const name of fs.readdirSync(logDir())) {
      const matched = FILE_PATTERN.exec(name)
      if (!matched) continue
      const fileTime = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])).getTime()
      if (fileTime < cutoff) {
        fs.unlinkSync(path.join(logDir(), name))
        removed += 1
      }
    }
  } catch (error) {
    console.error('[log] 清理失败:', error)
  }

  return removed
}

/** 列出可用日志文件（日期倒序） */
export function listLogFiles(): LogFileInfo[] {
  try {
    ensureDir()
    return fs
      .readdirSync(logDir())
      .map((name) => {
        const matched = FILE_PATTERN.exec(name)
        if (!matched) return null
        const stat = fs.statSync(path.join(logDir(), name))
        return { date: `${matched[1]}${matched[2]}${matched[3]}`, size: stat.size }
      })
      .filter((item): item is LogFileInfo => item !== null)
      .sort((a, b) => b.date.localeCompare(a.date))
  } catch {
    return []
  }
}

/** 读取指定日期的日志（最新在前），可按连接与关键字过滤 */
export function readLogs(query: LogQuery): LogEntry[] {
  const date = query.date && /^\d{8}$/.test(query.date) ? query.date : dateKey(new Date())
  const file = path.join(logDir(), `${date}.log`)
  if (!fs.existsSync(file)) return []

  const keyword = query.keyword?.trim().toLowerCase() ?? ''
  const entries: LogEntry[] = []
  const lines = fs.readFileSync(file, 'utf-8').split('\n')

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line) continue
    const entry = parseLine(line)
    if (!entry) continue
    if (query.connection && entry.connectionName !== query.connection) continue
    if (keyword) {
      const haystack = `${entry.action} ${entry.detail} ${entry.result}`.toLowerCase()
      if (!haystack.includes(keyword)) continue
    }
    entries.push(entry)
    if (entries.length >= MAX_ENTRIES) break
  }

  return entries
}

/** 在系统文件管理器中打开日志目录 */
export async function openLogDir(): Promise<void> {
  ensureDir()
  await shell.openPath(logDir())
}
/*
 * ============================================================
 * 错误日志（2026-10 用户需求：报错落本地 log 文件夹，信息尽量全面）
 *
 * 与操作日志刻意分成两个文件：
 *   · 操作日志 yyyymmdd.log：单行管道格式，grep 友好；
 *   · 错误日志 errors-yyyymmdd.log：多行块格式 —— 堆栈天然多行，
 *     塞进单行管道格式会把行结构打碎（sanitize 会把堆栈的换行抹掉，
 *     排查最需要的堆栈就没了）。
 *
 * 块格式（每条错误一个块，分隔线隔开）：
 *   ===== 2026-10-26 20:15:45.123 [renderer] =====
 *   message: TypeError: scoreDraft.trim is not a function
 *   info: render function
 *   version: 0.2.5  platform: win32-x64 / Electron 33.2.1
 *   stack:
 *     at Proxy._sfc_render (...)
 *     at ...
 *
 * 保留策略与操作日志一致（logRetentionDays）；FILE_PATTERN 只匹配
 * 操作日志的 yyyymmdd.log，prune 不会误删 errors-*.log ——
 * 错误日志单独 prune（ERROR_FILE_PATTERN），保留窗口同设置值。
 * ============================================================
 */
const ERROR_FILE_PATTERN = /^errors-(\d{4})(\d{2})(\d{2})\.log$/

function errorFileOf(timestamp: number): string {
  return path.join(logDir(), `errors-${dateKey(new Date(timestamp))}.log`)
}

/** 单文件上限（字节）：堆栈可能很长，超限轮转到下一文件防止无限膨胀 */
const ERROR_FILE_MAX_BYTES = 5 * 1024 * 1024

function formatErrorBlock(report: ErrorReport): string {
  const lines: string[] = []
  lines.push(`===== ${timeText(report.timestamp)} [${report.source}] =====`)
  lines.push(`message: ${report.message.replace(/\s+/g, ' ').trim()}`)
  if (report.info) lines.push(`info: ${report.info.replace(/\s+/g, ' ').trim()}`)
  const meta = [
    report.version ? `version: ${report.version}` : '',
    report.platform ? `platform: ${report.platform}` : '',
  ]
    .filter(Boolean)
    .join('  ')
  if (meta) lines.push(meta)
  if (report.stack) {
    lines.push('stack:')
    /* 堆栈每行缩进两格：与块头字段视觉区分，肉眼扫读时一眼定位 */
    for (const line of report.stack.split('\n')) {
      if (line.trim()) lines.push(`  ${line.trimEnd()}`)
    }
  }
  return lines.join('\n')
}

/** 追加一条错误报告；进程级兜底 —— 自身异常绝不向上抛（写日志失败不能再触发错误日志） */
export function appendErrorLog(report: ErrorReport): void {
  try {
    ensureDir()
    const file = errorFileOf(report.timestamp)
    /* 超上限轮转：errors-yyyymmdd.log → errors-yyyymmdd-1.log …
     * 排查通常只看最近一份，轮转序号从小到大即从旧到新 */
    let target = file
    let seq = 0
    while (fs.existsSync(target) && fs.statSync(target).size > ERROR_FILE_MAX_BYTES) {
      seq += 1
      target = file.replace(/\.log$/, `-${seq}.log`)
    }
    fs.appendFileSync(target, `${formatErrorBlock(report)}\n\n`, 'utf-8')
    pruneOldErrorLogs()
  } catch {
    /* 吞掉：落盘失败时只剩 console 这条退路 */
  }
}

/** 清理超出保留天数的错误日志（与操作日志同一设置项） */
export function pruneOldErrorLogs(): number {
  const retention = loadSettings().logRetentionDays || 30
  const cutoff = Date.now() - retention * 86400_000
  let removed = 0
  try {
    ensureDir()
    for (const name of fs.readdirSync(logDir())) {
      const matched = ERROR_FILE_PATTERN.exec(name)
      if (!matched) continue
      const fileTime = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])).getTime()
      if (fileTime < cutoff) {
        fs.unlinkSync(path.join(logDir(), name))
        removed += 1
      }
    }
    /* 轮转文件跟随主文件：主文件过期后 -n 文件一并清（前缀日期同源） */
    for (const name of fs.readdirSync(logDir())) {
      const rotated = /^errors-(\d{4})(\d{2})(\d{2})-\d+\.log$/.exec(name)
      if (!rotated) continue
      const fileTime = new Date(Number(rotated[1]), Number(rotated[2]) - 1, Number(rotated[3])).getTime()
      if (fileTime < cutoff) {
        fs.unlinkSync(path.join(logDir(), name))
        removed += 1
      }
    }
  } catch {
    /* 清理失败不影响写入路径 */
  }
  return removed
}
