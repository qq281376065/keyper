#!/usr/bin/env node
/**
 * 从 redis-doc 的 commands.json 生成离线命令目录。
 *
 * 数据源已入库（scripts/data/redis-commands.json），生成过程不联网：
 *   node scripts/gen-command-catalog.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'scripts/data/redis-commands.json')
const OUT = path.join(ROOT, 'shared/redis-commands.ts')

const raw = JSON.parse(fs.readFileSync(SRC, 'utf-8'))
const entries = Object.entries(raw)
  .map(([name, info]) => ({
    name,
    summary: String(info.summary ?? ''),
    group: String(info.group ?? 'generic'),
    since: String(info.since ?? ''),
    arity: Number(info.arity ?? 0),
    readonly: Array.isArray(info.command_flags) && info.command_flags.includes('readonly'),
  }))
  .sort((a, b) => a.name.localeCompare(b.name))

const lines = entries.map(
  (item) =>
    `  { name: ${JSON.stringify(item.name)}, summary: ${JSON.stringify(item.summary)}, group: ${JSON.stringify(item.group)}, since: ${JSON.stringify(item.since)}, arity: ${item.arity}, readonly: ${item.readonly} },`,
)

const content = `/**
 * Redis 命令目录（离线快照，自动生成，请勿手改）。
 *
 * 数据来源：redis-doc/commands.json
 * 重新生成：node scripts/gen-command-catalog.mjs
 * 共 ${entries.length} 条，含容器命令的子命令（如 CLIENT LIST）。
 */
export interface RedisCommandInfo {
  name: string
  summary: string
  group: string
  since: string
  arity: number
  readonly: boolean
}

export const REDIS_COMMANDS: RedisCommandInfo[] = [
${lines.join('\n')}
]
`

fs.writeFileSync(OUT, content, 'utf-8')
console.log(`generated ${entries.length} commands -> ${path.relative(ROOT, OUT)}`)
