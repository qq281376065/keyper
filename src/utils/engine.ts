import type { CacheConnectionConfig } from '@shared/types'
import type { ConnectionItem } from '@/store/session'

/**
 * 引擎元信息。
 *
 * 集中在一处而不是散落在各个组件里，是为了让"新增一个引擎"变成
 * 只改这一个文件 + 加一个适配器的局部工作：
 * 列表角标、下拉选项、筛选器都从这张表取，不会出现
 * "列表加了角标但筛选器漏了 Memcached"这类不一致。
 */
export interface EngineMeta {
  /** 引擎标识 */
  key: CacheConnectionConfig['engine']
  /** 界面上显示的名字 */
  label: string
  /** 单字母角标（日志行、Memcached 概览等紧凑位置的圆形徽标） */
  short: string
  /** 默认端口 —— 新建时按引擎自动带出，省一次手动输入 */
  defaultPort: number
  /** 一句话说明，用于选择引擎时的提示 */
  hint: string
}

export const ENGINES: readonly EngineMeta[] = [
  {
    key: 'redis',
    label: 'Redis',
    short: 'R',
    defaultPort: 6379,
    hint: '多库 · 六种结构 · Pub/Sub · SSH',
  },
  {
    key: 'memcached',
    label: 'Memcached',
    short: 'M',
    defaultPort: 11211,
    hint: '纯键值缓存 · slab 分组 · SSH 跳板',
  },
] as const

/** 按引擎取元信息；未知引擎回退到 Redis，保证界面不会因为脏数据崩掉 */
export function engineMeta(engine: CacheConnectionConfig['engine'] | undefined): EngineMeta {
  return ENGINES.find((item) => item.key === engine) ?? ENGINES[0]
}

/**
 * 把界面条目还原成可持久化的配置。
 *
 * ConnectionItem = 配置 + 运行时字段（status / latency / version / mode / sshHost）。
 * 把这些字段一起存盘会让配置文件里出现"上次连上时的延迟"这类
 * 早已过期的快照，而且 status 会在下次启动时被读成 connected —— 是脏数据。
 *
 * 这里用"挑字段"而不是"删字段"：以后给状态加字段时，
 * 不需要回来同步维护一张删除名单（漏一个就写脏一次）。
 */
export function toConfig(item: ConnectionItem): CacheConnectionConfig {
  const base = {
    id: item.id,
    name: item.name,
    host: item.host,
    port: item.port,
    ...(item.pinned ? { pinned: item.pinned } : {}),
    ...(item.credentialError ? { credentialError: item.credentialError } : {}),
  }

  if (item.engine === 'memcached') {
    return {
      ...base,
      engine: 'memcached',
      ...(item.poolSize ? { poolSize: item.poolSize } : {}),
      ...(item.ssh ? { ssh: item.ssh } : {}),
      ...(item.sshEnabled ? { sshEnabled: item.sshEnabled } : {}),
    }
  }

  return {
    ...base,
    engine: 'redis',
    db: item.db,
    ...(item.username ? { username: item.username } : {}),
    ...(item.password ? { password: item.password } : {}),
    ...(item.tls ? { tls: item.tls } : {}),
    ...(item.ssh ? { ssh: item.ssh } : {}),
    ...(item.sshEnabled ? { sshEnabled: item.sshEnabled } : {}),
  }
}
