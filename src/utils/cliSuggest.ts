import { REDIS_COMMANDS } from '@shared/redis-commands'

export interface CliSuggestion {
  kind: 'command' | 'subcommand' | 'key'
  /** 采纳后直接写回输入框的完整文本 */
  value: string
  /** 菜单中展示的短文本（子命令只显示后半段） */
  label: string
  /** redis-doc 命令分组（协议术语，保留英文） */
  group?: string
  /** 引入版本 */
  since?: string
  readonly?: boolean
}

const MAX = 8

function quoteKey(key: string): string {
  return /[\s"']/.test(key) ? `"${key}"` : key
}

export function buildCliSuggestions(
  input: string,
  keys: string[],
  limit = MAX,
): CliSuggestion[] {
  const raw = input
  const endsWithSpace = /\s$/.test(raw)
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) {
    return REDIS_COMMANDS.filter((item) => !item.name.includes(' '))
      .slice(0, limit)
      .map((item) => ({
        kind: 'command' as const,
        value: `${item.name} `,
        label: item.name,
        group: item.group,
        since: item.since,
        readonly: item.readonly,
      }))
  }

  const first = tokens[0].toUpperCase()

  if (tokens.length === 1 && !endsWithSpace) {
    const prefix = first
    return REDIS_COMMANDS.filter(
      (item) => !item.name.includes(' ') && item.name.startsWith(prefix),
    )
      .slice(0, limit)
      .map((item) => ({
        kind: 'command' as const,
        value: `${item.name} `,
        label: item.name,
        group: item.group,
        since: item.since,
        readonly: item.readonly,
      }))
  }

  const subcommands = REDIS_COMMANDS.filter((item) => item.name.startsWith(`${first} `))
  const currentPrefix = endsWithSpace ? '' : tokens[tokens.length - 1].toUpperCase()
  const wantsSubcommand =
    subcommands.length > 0 &&
    (tokens.length === 1 || (tokens.length === 2 && !endsWithSpace))

  if (wantsSubcommand) {
    const matched = subcommands
      .filter((item) => item.name.slice(first.length + 1).startsWith(currentPrefix))
      .slice(0, limit)
      .map((item) => ({
        kind: 'subcommand' as const,
        value: `${item.name} `,
        label: item.name.slice(first.length + 1),
        group: item.group,
        since: item.since,
        readonly: item.readonly,
      }))
    if (matched.length) return matched
  }

  const keyPrefix = endsWithSpace ? '' : tokens[tokens.length - 1]
  const head = endsWithSpace ? tokens.join(' ') : tokens.slice(0, -1).join(' ')
  return keys
    .filter((key) => key.toLowerCase().startsWith(keyPrefix.toLowerCase()))
    .slice(0, limit)
    .map((key) => ({
      kind: 'key' as const,
      value: `${head} ${quoteKey(key)} `.trimStart(),
      label: key,
    }))
}
