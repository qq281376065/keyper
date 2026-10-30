import type { RedisDesktopApi } from '@shared/api'
import { APP_VERSION } from '@/services/errorReport'
import { memoryPrefixOf, MEMORY_BUCKET_LIMIT } from '@shared/keyspace'
import type {
  ApiResponse,
  AppSettings,
  CliResult,
  ConnectionState,
  DatabaseInfo,
  EnvInfo,
  ErrorReport,
  KeyValue,
  LogEntry,
  LogFileInfo,
  LogQuery,
  MemcachedKeyList,
  MemcachedOverview,
  MemcachedSlab,
  MemcachedValue,
  MemoryAnalysis,
  MemoryBucket,
  OperationResult,
  UpdateCheckResult,
  CacheConnectionConfig,
  RedisConnectionConfig,
  RedisKeyItem,
  RedisValueType,
  ScanResult,
  SearchAllOptions,
  SearchAllResult,
  SearchHistoryEntry,
  SearchProgress,
  ServerInfo,
  SlowlogEntry,
  SlowlogOverview,
  PubsubMessage,
  PubsubState,
  VersionInfo,
} from '@shared/types'

/**
 * 纯浏览器预览用的 Mock 实现。
 * 当应用运行在 Electron 容器内时不会加载此文件；
 * 目的是让 `npm run dev` 直接在浏览器打开也能看到完整交互效果。
 */

const delay = (ms = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * UTF-8 字节数。
 *
 * ⚠️ 不能用 Buffer.byteLength：mock 同时运行在浏览器（dev:web 预览）
 * 与 Electron 渲染进程里，而浏览器没有 Node 的 Buffer 全局 ——
 * 直接调用会抛 "Buffer is not defined"，整个面板变成错误态。
 * TextEncoder 是两边都有的标准 API，且在 UTF-8 下与 Buffer 结果一致。
 */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length
const ok = <T>(data: T): ApiResponse<T> => ({ ok: true, data })

/*
 * 演示连接：两种引擎混排，用于验证
 *   ① 连接列表的引擎角标能一眼区分；
 *   ② 两个引擎的配置、状态、面板互不干扰。
 * Memcached 的端口用 11211（默认端口），不写 db —— 它没有库的概念。
 */
const CONNECTIONS: CacheConnectionConfig[] = [
  { id: 'local', engine: 'redis', name: '本地开发', host: '127.0.0.1', port: 6379, db: 0 },
  { id: 'staging', engine: 'redis', name: '测试环境', host: '192.168.1.45', port: 6379, db: 2, username: 'default' },
  { id: 'prod', engine: 'redis', name: '生产（只读）', host: 'redis-prod.internal', port: 6380, db: 0, tls: true },
  { id: 'modern', engine: 'redis', name: '新版演示 (7.4+)', host: '127.0.0.1', port: 6381, db: 0 },
  { id: 'mc-local', engine: 'memcached', name: '本地缓存', host: '127.0.0.1', port: 11211, poolSize: 4 },
  { id: 'mc-session', engine: 'memcached', name: '会话缓存（生产）', host: 'mc-session.internal', port: 11211, poolSize: 8 },
]

/*
 * 拖拽排序的"跨重启"持久化（浏览器预览模拟）。
 * 真实实现落在 connections.json 的数组顺序里；mock 没有磁盘，
 * 用 localStorage 存 id 序列，模块加载时应用 —— CDP 验证「刷新后顺序保留」依赖这一点。
 */
const ORDER_KEY = 'rd-mock-conn-order'
try {
  const saved = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]') as string[]
  if (Array.isArray(saved) && saved.length) {
    const known = new Set(CONNECTIONS.map((item) => item.id))
    const byId = new Map(CONNECTIONS.map((item) => [item.id, item]))
    const ordered = saved.filter((id) => known.has(id)).map((id) => byId.get(id)!)
    for (const item of CONNECTIONS) if (!saved.includes(item.id)) ordered.push(item)
    CONNECTIONS.splice(0, CONNECTIONS.length, ...ordered)
  }
} catch {
  /* localStorage 不可用（隐私模式等）就回到默认顺序 */
}

/**
 * 预览环境的服务端版本。
 * 通过连接 id 区分版本，用于演示「按 redis_version 决定字段级 TTL 是否可用」：
 * modern 连接为 7.4.4（支持 HEXPIRE/HTTL），其余为 7.2.4（不支持）。
 */
const MOCK_VERSIONS: Record<string, string> = {
  local: '7.2.4',
  staging: '7.2.4',
  prod: '7.2.4',
  modern: '7.4.4',
}

const DEFAULT_VERSION = '7.2.4'

/** 当前连接 id 对应的模拟版本（connect 时记录） */
let activeVersion = DEFAULT_VERSION

function versionOf(connectionId?: string): string {
  if (connectionId && MOCK_VERSIONS[connectionId]) return MOCK_VERSIONS[connectionId]
  return activeVersion
}

/** 该连接是否支持字段级 TTL（Redis >= 7.4） */
export function supportsFieldTtl(connectionId?: string): boolean {
  const matched = /^(\d+)\.(\d+)/.exec(versionOf(connectionId))
  if (!matched) return false
  const major = Number(matched[1])
  const minor = Number(matched[2])
  return major > 7 || (major === 7 && minor >= 4)
}

/** hash 字段的模拟 TTL 表：仅 modern 连接有值 */
const HASH_FIELD_TTLS: Record<string, Record<string, number>> = {
  'user:1001:profile': { id: 1800, name: 1800, role: 900, level: -1, city: 45, createdAt: -1 },
  'user:1002:profile': { id: 600, name: -1, role: -1, level: 120, city: -1, createdAt: -1 },
  'config:feature:flags': { newCheckout: 3600, aiSearch: -1, darkMode: -1, grayScale: 300 },
}

/*
 * 慢查询日志的可变数据：RESET 必须真的清空，否则「清空后列表为空」
 * 只能靠界面假动作骗过 CDP（与批次 3 setTtl/rename 真实化同一教训）。
 * 时间戳相对当前时刻生成，保证预览里永远是"几分钟前"的真实观感。
 */
const nowSec = () => Math.floor(Date.now() / 1000)

const SLOWLOG: SlowlogEntry[] = [
  {
    id: 14,
    timestamp: nowSec() - 95,
    duration: 12400,
    command: ['GET', 'user:1001:profile'],
    client: '127.0.0.1:58217',
    clientName: 'redis-desktop',
  },
  {
    id: 13,
    timestamp: nowSec() - 18 * 60,
    duration: 1180000,
    command: ['KEYS', '*'],
    client: '192.168.1.45:51234',
    clientName: '',
  },
  {
    id: 12,
    timestamp: nowSec() - 62 * 60,
    duration: 463200,
    command: ['SMEMBERS', 'analytics:2026:10:dau'],
    client: '127.0.0.1:58218',
    clientName: '',
  },
  {
    id: 11,
    timestamp: nowSec() - 3 * 3600,
    duration: 18300,
    command: ['LRANGE', 'queue:email:pending', '0', '-1'],
    client: '10.2.8.31:40221',
    clientName: 'app-worker-1',
  },
]

/*
 * Pub/Sub 模拟：订阅状态与消息监听都存模块级（按连接 id 隔离）。
 * publish 的回声语义 —— 自己订阅的频道自己发布也能收到 ——
 * 是 CDP 验证「订阅 → 发布 → 消息流出现记录」闭环的唯一手段：
 * mock 必须在 publish 后把消息推给已注册的监听者（延迟模拟网络往返）。
 */
const PUBSUB_SUBS = new Map<string, { channels: Set<string>; patterns: Set<string> }>()
const pubsubListeners = new Set<(message: PubsubMessage) => void>()

/*
 * 全库搜索模拟：取消令牌 + 进度监听都存模块级（与真实主进程同构）。
 * searchAll 分两段延迟 —— 100ms 推一次进度、260ms 返回 —— 让 CDP 能在
 * 扫描「进行中」点停止：令牌失效后返回已找到的前一半 + cancelled=true，
 * 对齐真实主进程「取消时返回已扫到的部分」的语义。
 */
const searchTokens = new Map<string, number>()
const searchProgressListeners = new Set<(progress: SearchProgress) => void>()

function emitSearchProgress(progress: SearchProgress): void {
  for (const listener of searchProgressListeners) listener(progress)
}

/** PSUBSCRIBE 的 glob 语义：* 任意串、? 单字符，其余原样 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

function pubsubStateOf(id: string): PubsubState {
  const subs = PUBSUB_SUBS.get(id)
  return {
    channels: subs ? [...subs.channels] : [],
    patterns: subs ? [...subs.patterns] : [],
  }
}

interface MockKey {
  key: string
  type: RedisValueType
  ttl: number
}

const KEYS: MockKey[] = [
  { key: 'user:1001:profile', type: 'hash', ttl: -1 },
  { key: 'user:1002:profile', type: 'hash', ttl: -1 },
  { key: 'user:1001:token', type: 'string', ttl: 1842 },
  { key: 'cache:home:feed', type: 'string', ttl: 62 },
  { key: 'cache:product:8891', type: 'string', ttl: 305 },
  { key: 'session:9f2a1c7e', type: 'string', ttl: 7180 },
  { key: 'session:3b8d0f51', type: 'string', ttl: 6015 },
  { key: 'queue:email:pending', type: 'list', ttl: -1 },
  { key: 'queue:sms:retry', type: 'list', ttl: -1 },
  { key: 'online:users:sh', type: 'set', ttl: 24 },
  { key: 'tag:product:hot', type: 'set', ttl: -1 },
  { key: 'ranking:hot:2026-10-16', type: 'zset', ttl: 86400 },
  { key: 'ranking:sales:weekly', type: 'zset', ttl: 61200 },
  { key: 'ratelimit:api:10.0.3.22', type: 'string', ttl: 43 },
  { key: 'lock:order:20261016-8842', type: 'string', ttl: 9 },
  { key: 'config:feature:flags', type: 'hash', ttl: -1 },
  { key: 'config:app:settings', type: 'hash', ttl: -1 },
  { key: 'config:pay:channels', type: 'hash', ttl: -1 },
  { key: 'stats:dau:20261015', type: 'string', ttl: -1 },
  { key: 'geo:shops:cs', type: 'zset', ttl: -1 },
  { key: 'stream:orders:events', type: 'stream', ttl: -1 },
  // 无冒号的键：用于验证树形视图在没有分隔符时的展示与分组行为
  { key: 'healthcheck', type: 'string', ttl: -1 },
  { key: 'app-version', type: 'string', ttl: -1 },
  { key: 'maintenance_mode', type: 'string', ttl: -1 },
  { key: 'feature.rollout', type: 'string', ttl: 5400 },
  { key: 'counter2026', type: 'string', ttl: -1 },

  /*
   * 以下为「批量删除」面板准备的演示数据。
   *
   * 原有数据每个顶层前缀只有 1–3 个键，达不到批量删除的阈值，
   * 导致该功能在演示环境里完全无法触达 —— 不是功能没实现，
   * 而是数据量不够。这里给 bulkdemo 前缀补 60 个键，
   * 超过 50 的阈值，可完整验证清单滚动、搜索、逐个删除与进度。
   */
  ...Array.from({ length: 60 }, (_, index) => ({
    key: `bulkdemo:item:${String(index + 1).padStart(3, '0')}`,
    type: (['string', 'hash', 'list', 'set', 'zset'] as const)[index % 5],
    ttl: index % 3 === 0 ? -1 : 600 + index * 37,
  })),
]

/*
 * mock 的 MEMORY USAGE 字节数：必须**确定可算**（CDP 断言依赖精确值，
 * 不掺随机数）—— 基础开销按类型近似真实 Redis + 键名长度。
 */
const MOCK_MEMORY_BASE: Record<string, number> = {
  string: 56,
  hash: 120,
  list: 140,
  set: 130,
  zset: 160,
  stream: 200,
}

const STRINGS: Record<string, string> = {
  'user:1001:token': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjEwMDEsImV4cCI6MTc2MTAwMDAwMH0.Kx7fQ2mT9vLp',
  'cache:home:feed': JSON.stringify(
    { feedId: 8891, items: 24, generatedAt: '2026-10-16T08:12:03+08:00', ttlHint: 60 },
    null,
    2,
  ),
  'cache:product:8891': '{"sku":"8891","name":"机械键盘 87 键","price":42900,"stock":132}',
  'session:9f2a1c7e': '{"uid":1001,"ip":"10.0.3.22","ua":"Chrome/141","loginAt":1760668000}',
  'session:3b8d0f51': '{"uid":1002,"ip":"10.0.3.99","ua":"Safari/18","loginAt":1760661200}',
  'ratelimit:api:10.0.3.22': '37',
  'lock:order:20261016-8842': '1',
  'stats:dau:20261015': '428193',
  // 无冒号的键对应的值
  healthcheck: '{"status":"ok","uptime":186432,"version":"1.14.2"}',
  'app-version': '1.14.2',
  maintenance_mode: 'false',
  'feature.rollout': '{"newCheckout":0.25,"aiSearch":0.05}',
  counter2026: '1284401',
}

const HASHS: Record<string, Record<string, string>> = {
  'user:1001:profile': { id: '1001', name: '张伟', role: 'admin', level: '7', city: '长沙', createdAt: '2024-03-11' },
  'user:1002:profile': { id: '1002', name: '李娜', role: 'member', level: '3', city: '深圳', createdAt: '2025-07-02' },
  'config:feature:flags': { newCheckout: 'true', aiSearch: 'false', darkMode: 'true', grayScale: '0.15' },
  'config:pay:channels': { wechat: 'enabled', alipay: 'enabled', unionpay: 'disabled' },
  /** 字段较多的大 hash，用于验证长表格的滚动与表头吸顶 */
  'config:app:settings': Object.fromEntries(
    [
      'theme', 'locale', 'timezone', 'pageSize', 'autoSave', 'autoSaveInterval', 'editorFont',
      'editorFontSize', 'tabSize', 'wordWrap', 'lineNumbers', 'minimap', 'smoothScroll',
      'confirmDelete', 'recentLimit', 'historyDepth', 'telemetry', 'updateChannel',
      'proxyEnabled', 'proxyHost', 'proxyPort', 'cacheDir', 'logLevel', 'logRetentionDays',
      'pluginAutoUpdate',
    ].map((key, index) => [key, `value-${index + 1}`]),
  ),
}

const LISTS: Record<string, string[]> = {
  'queue:email:pending': ['{"to":"a@x.com","tpl":"welcome"}', '{"to":"b@x.com","tpl":"reset"}', '{"to":"c@x.com","tpl":"invoice"}'],
  'queue:sms:retry': ['13800001111|code:8821', '13900002222|code:4417'],
}

const SETS: Record<string, string[]> = {
  'online:users:sh': ['1001', '1002', '1108', '1240', '1388'],
  'tag:product:hot': ['8891', '8892', '9013', '9102'],
}

const ZSETS: Record<string, string[]> = {
  'ranking:hot:2026-10-16': ['8891 :: 9821', '9013 :: 8744', '8892 :: 7310', '9102 :: 6288'],
  'ranking:sales:weekly': ['9013 :: 15220', '8891 :: 12980', '9102 :: 9440'],
  'geo:shops:cs': ['shop:001 :: 112.9388', 'shop:002 :: 112.9812', 'shop:003 :: 113.0211'],
}

const STREAMS: Record<string, string[]> = {
  'stream:orders:events': [
    '1760668800123-0 :: {"event":"created","orderId":"8842"}',
    '1760668801456-0 :: {"event":"paid","orderId":"8842"}',
    '1760668802778-0 :: {"event":"shipped","orderId":"8841"}',
    // 长字段：用于验证「单行截断 + 悬停看全文」
    '1760668803091-0 :: {"event":"notified","orderId":"8842","channel":"sms","payload":"{\\"template\\":\\"order_paid\\",\\"merchant\\":\\"长沙德思勤广场旗舰店\\",\\"items\\":[{\\"sku\\":\\"SKU-8842-01\\",\\"name\\":\\"无线降噪耳机 Pro\\",\\"qty\\":2},{\\"sku\\":\\"SKU-8842-02\\",\\"name\\":\\"便携充电底座\\",\\"qty\\":1}],\\"amount\\":\\"¥1,299.00\\",\\"remark\\":\\"用户备注：工作日 18 点后配送，请提前电话联系\\"}"}',
    // 扁平 key=value 形式：真实 XADD 的常见形态，无 JSON 结构可美化
    '1760668804120-0 :: user_id=1001 page=/checkout/confirm ip=203.0.113.42 ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    // 多字段 + 极长单值
    '1760668805333-0 :: trace_id=7f3a9b2c-4d51-4e88-9a10-6c2b8f7e1d40 level=error service=payment-gateway message=上游渠道返回超时，已触发重试（第 3 次），本批次共 128 笔订单受影响，请运维核查渠道健康状态与限流配置',
    // 纯短值：与长值对照，验证表格行高一致
    '1760668806444-0 :: status=ok',
    // 序号带两位数的边界样本：验证 entry ID 按数值排序（…-10 应大于 …-9）
    '1760668807999-9 :: status=ok',
    '1760668807999-10 :: status=ok',
    // 空字段边界
    '1760668808888-0 :: ',
  ],
}

const DATABASES: DatabaseInfo[] = [
  { db: 0, keys: 1284 },
  { db: 1, keys: 0 },
  { db: 2, keys: 316 },
  { db: 3, keys: 42 },
  { db: 4, keys: 0 },
  { db: 5, keys: 7 },
]

const SERVER_INFO: ServerInfo = {
  version: '7.2.4',
  mode: 'standalone',
  os: 'Linux 5.10.0-28-amd64 x86_64',
  processId: 31274,
  uptimeInDays: 63,
  connectedClients: 18,
  usedMemoryHuman: '184.62M',
  usedMemoryLua: '1.12M',
  totalKeys: 1284,
  hitRate: 98.7,
  opsPerSec: 412,
}

const CLI_HISTORY: Record<string, CliResult> = {
  ping: { output: 'PONG', costMs: 1 },
  info: { output: '# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone', costMs: 3 },
  dbsize: { output: '1284', costMs: 1 },
}

/** ---------------------------------------------------------------- 键搜索历史（预览用） */

/**
 * 与 electron/services/search-history-store.ts 同语义的 localStorage 版：
 * 按「连接 id @ 库号」分桶、LRU、30 条上限。
 * 两份实现的常量与行为必须保持一致 ——
 * scripts/check-search-history.mjs 会同时锁两边。
 */
const MOCK_HISTORY_KEY = 'redisdesktop:mock:searchHistory'
const MOCK_HISTORY_LIMIT = 30

type MockHistoryFile = Record<string, SearchHistoryEntry[]>

function loadMockHistory(): MockHistoryFile {
  try {
    const saved = JSON.parse(localStorage.getItem(MOCK_HISTORY_KEY) ?? 'null') as MockHistoryFile | null
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  } catch {
    return {}
  }
}

function saveMockHistory(data: MockHistoryFile): void {
  try {
    localStorage.setItem(MOCK_HISTORY_KEY, JSON.stringify(data))
  } catch {
    /* 落盘失败不影响当前会话 */
  }
}

function mockBucketKey(connId: string, db: number): string {
  return `${connId}@${db}`
}

function mockHistoryOf(connId: string, db: number): SearchHistoryEntry[] {
  return loadMockHistory()[mockBucketKey(connId, db)] ?? []
}

function mockRecordHistory(connId: string, db: number, term: string): SearchHistoryEntry[] {
  const q = term.trim()
  if (!q) return mockHistoryOf(connId, db)
  const key = mockBucketKey(connId, db)
  const data = loadMockHistory()
  const bucket = data[key] ?? []
  const now = Date.now()
  const i = bucket.findIndex((e) => e.q === q)
  if (i >= 0) {
    const [hit] = bucket.splice(i, 1)
    bucket.unshift({ q: hit.q, count: hit.count + 1, at: now })
  } else {
    bucket.unshift({ q, count: 1, at: now })
    if (bucket.length > MOCK_HISTORY_LIMIT) bucket.length = MOCK_HISTORY_LIMIT
  }
  data[key] = bucket
  saveMockHistory(data)
  return bucket
}

function mockRemoveHistory(connId: string, db: number, term: string): SearchHistoryEntry[] {
  const key = mockBucketKey(connId, db)
  const data = loadMockHistory()
  const bucket = data[key]
  if (!bucket) return []
  const next = bucket.filter((e) => e.q !== term)
  if (next.length) data[key] = next
  else delete data[key]
  saveMockHistory(data)
  return next
}

function mockClearHistory(connId: string, db: number): SearchHistoryEntry[] {
  const key = mockBucketKey(connId, db)
  const data = loadMockHistory()
  if (key in data) {
    delete data[key]
    saveMockHistory(data)
  }
  return []
}

/** ---------------------------------------------------------------- 设置与日志（预览用） */

/**
 * 设置的 localStorage 落盘：真实实现持久化到 settings.json，
 * 浏览器预览没有文件系统，用同一份存储模拟「重启后设置保留」——
 * CDP 验证刷新后主题/字号等不回默认依赖这一点。
 */
const MOCK_SETTINGS_KEY = 'redisdesktop:mock:settings'

const DEFAULT_MOCK_SETTINGS: AppSettings = {
  fontSize: 13,
  uiFont: 'system',
  monoFont: 'jetbrains-mono',
  density: 'compact',
  pageSize: 200,
  keySeparator: ':',
  confirmDelete: true,
  logRetentionDays: 30,
  theme: 'system',
  viewMode: 'tree',
  cliCollapsed: true,
  sidebarCollapsed: false,
  keyBrowserWidth: 420,
  lastConnectionId: null,
  lastDb: 0,
  expandedPaths: {},
}

function loadMockSettings(): AppSettings {
  try {
    const saved = JSON.parse(
      localStorage.getItem(MOCK_SETTINGS_KEY) ?? 'null',
    ) as Partial<AppSettings> | null
    if (saved) return { ...DEFAULT_MOCK_SETTINGS, ...saved }
  } catch {
    /* localStorage 不可用（隐私模式等）就回到默认 */
  }
  return { ...DEFAULT_MOCK_SETTINGS }
}

let mockSettings: AppSettings = loadMockSettings()

function dayKey(offsetDays = 0): string {
  const date = new Date(Date.now() - offsetDays * 86400_000)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}${month}${day}`
}

const MOCK_LOG_PRESETS: Array<Omit<LogEntry, 'timestamp' | 'connectionId'>> = [
  { engine: 'redis', connectionName: '本地开发', action: '命令', detail: 'SET cache:home:feed {...}', ok: true, result: 'OK', costMs: 2 },
  { engine: 'redis', connectionName: '本地开发', action: '新建键', detail: 'order:20261016:8842 (hash)', ok: true, result: '已创建 order:20261016:8842', costMs: 6 },
  { engine: 'memcached', connectionName: '本地缓存', action: '写入键', detail: 'session:3b8d0f51 (expire 1800s)', ok: true, result: 'STORED', costMs: 3 },
  { engine: 'redis', connectionName: '测试环境', action: '命令', detail: 'FLUSHDB ASYNC', ok: true, result: 'OK', costMs: 8 },
  { engine: 'memcached', connectionName: '本地缓存', action: '命令', detail: 'get user:1001:profile', ok: true, result: '1 个键命中', costMs: 1 },
  { engine: 'redis', connectionName: '测试环境', action: '删除键', detail: 'session:3b8d0f51', ok: true, result: '已删除 1 个键', costMs: 5 },
  { engine: 'memcached', connectionName: '会话缓存（生产）', action: '删除键', detail: 'session:expired:88f1', ok: true, result: 'DELETED', costMs: 2 },
  { engine: 'redis', connectionName: '生产（只读）', action: '建立连接', detail: 'redis-prod.internal:6380/0', ok: false, result: '连接超时', costMs: 8001 },
  { engine: 'memcached', connectionName: '本地缓存', action: '命令', detail: 'flush_all', ok: true, result: 'OK', costMs: 12 },
]

function mockLogsFor(date: string): LogEntry[] {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(4, 6)) - 1
  const d = Number(date.slice(6, 8))
  const base = new Date(y, m, d, 17, 30, 0).getTime()

  return MOCK_LOG_PRESETS.map((preset, index) => ({
    ...preset,
    timestamp: base - index * 137_000,
    /* 连接 id 按名称映射到演示配置，保证日志筛选能对上列表 */
    connectionId:
      preset.connectionName === '本地开发'
        ? 'local'
        : preset.connectionName === '本地缓存'
          ? 'mc-local'
          : preset.connectionName === '会话缓存（生产）'
            ? 'mc-session'
            : 'staging',
  }))
}

/*
 * 注意：返回时必须拷贝，不能直接交出数据源的引用。
 * 否则调用方（如本地插入 / 删除）在"服务端已改过数据源"之后再改动返回值，
 * 会作用到同一个数组上，表现为同一次操作插入两遍。
 */
/** 按首个 "::" 切分 zset / stream 的复合行（与前端 splitPair 语义一致） */
function splitPairMock(raw: string): [string, string] {
  const index = raw.indexOf('::')
  if (index < 0) return [raw.trim(), '']
  return [raw.slice(0, index).trim(), raw.slice(index + 2).trim()]
}

function mockValue(key: string): KeyValue {
  const meta = KEYS.find((item) => item.key === key)
  const type = meta?.type ?? 'string'
  const ttl = meta?.ttl ?? -1

  if (type === 'string') {
    const value = STRINGS[key] ?? ''
    return { key, type, ttl, encoding: 'embstr', length: value.length, value }
  }
  if (type === 'hash') {
    const value = { ...(HASHS[key] ?? {}) }
    return { key, type, ttl, encoding: 'listpack', length: Object.keys(value).length, value }
  }
  if (type === 'list') {
    const value = [...(LISTS[key] ?? [])]
    return { key, type, ttl, encoding: 'quicklist', length: value.length, value }
  }
  if (type === 'set') {
    const value = [...(SETS[key] ?? [])]
    return { key, type, ttl, encoding: 'listpack', length: value.length, value }
  }
  if (type === 'zset') {
    const value = [...(ZSETS[key] ?? [])]
    return { key, type, ttl, encoding: 'skiplist', length: value.length, value }
  }
  if (type === 'stream') {
    const value = [...(STREAMS[key] ?? [])]
    return { key, type, ttl, encoding: 'stream', length: value.length, value }
  }
  return { key, type: 'none', ttl: -2, value: null }
}

export const mockApi: RedisDesktopApi = {
  app: {
    getVersion: async () => ok(APP_VERSION),
    getEnvInfo: async (): Promise<ApiResponse<EnvInfo>> =>
      ok({
        appVersion: APP_VERSION,
        electron: '未运行（浏览器预览）',
        chrome: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '-',
        node: '未运行（浏览器预览）',
        v8: '-',
        platform: navigator.userAgent.includes('Windows') ? 'win32 x64' : '浏览器环境',
        arch: '-',
        locale: navigator.language,
        inElectron: false,
      }),
  },

  update: {
    /*
     * 浏览器预览下不真的联网：这里返回一份"已是最新"的结果，
     * 让界面能完整渲染结果态（而不是永远卡在检查中或报错）。
     */
    check: async (): Promise<ApiResponse<UpdateCheckResult>> =>
      ok({
        currentVersion: APP_VERSION,
        latestVersion: APP_VERSION,
        hasUpdate: false,
        notes: null,
        pageUrl: 'https://gitee.com/jack_ssdddd/redis-docter/tags',
        checkedAt: new Date().toISOString(),
        notice: '浏览器预览模式不会真的联网检查',
      }),
    openPage: async () => ok({ ok: true, message: '预览模式下不打开浏览器' }),
  },

  window: {
    // 浏览器预览没有窗口概念，全部 no-op（自绘按钮点了无反馈即正确行为）
    minimize: async () => ok(null),
    maxToggle: async () => ok(null),
    close: async () => ok(null),
    state: async () => ok({ maximized: false }),
    onStateChange: () => () => {},
    /* 浏览器里没有"窗口关闭"这回事，订阅一个永不触发的空监听 */
    onBeforeClose: () => () => {},
    closeHandled: () => {},
    confirmClose: () => {},
  },

  settings: {
    get: async (): Promise<ApiResponse<AppSettings>> => {
      await delay(60)
      return ok({ ...mockSettings })
    },
    save: async (patch: Partial<AppSettings>): Promise<ApiResponse<AppSettings>> => {
      await delay(120)
      mockSettings = { ...mockSettings, ...patch }
      try {
        localStorage.setItem(MOCK_SETTINGS_KEY, JSON.stringify(mockSettings))
      } catch {
        /* 写失败不影响当前会话（与 useTheme 的副本写法一致） */
      }
      return ok({ ...mockSettings })
    },
    // 浏览器预览没有真实文件系统，给一个示意路径
    configInfo: async () =>
      ok({ dir: '（浏览器预览无配置文件）', portable: false, reason: '当前运行在浏览器预览模式' }),
  },

  searchHistory: {
    get: async (connId: string, db: number) => ok(mockHistoryOf(connId, db)),
    record: async (connId: string, db: number, term: string) =>
      ok(mockRecordHistory(connId, db, term)),
    remove: async (connId: string, db: number, term: string) =>
      ok(mockRemoveHistory(connId, db, term)),
    clear: async (connId: string, db: number) => ok(mockClearHistory(connId, db)),
  },

  log: {
    dates: async (): Promise<ApiResponse<LogFileInfo[]>> =>
      ok([
        { date: dayKey(0), size: 4096 },
        { date: dayKey(1), size: 3584 },
        { date: dayKey(2), size: 2048 },
      ]),
    read: async (query: LogQuery): Promise<ApiResponse<LogEntry[]>> => {
      await delay(140)
      const date = query?.date && /^\d{8}$/.test(query.date) ? query.date : dayKey(0)
      const keyword = query?.keyword?.trim().toLowerCase() ?? ''
      const list = mockLogsFor(date)
        /*
         * 引擎筛选必须与主进程 log-service 的行为一致。
         * mock 漏掉这一条时，浏览器预览里切"模块"下拉毫无反应 ——
         * 而预览正是日常调界面用的环境，很容易被当成"功能没做"。
         */
        .filter((entry) => !query?.engine || entry.engine === query.engine)
        .filter((entry) => !query?.connection || entry.connectionName === query.connection)
        .filter(
          (entry) =>
            !keyword ||
            `${entry.action} ${entry.detail} ${entry.result}`.toLowerCase().includes(keyword),
        )
        .sort((a, b) => b.timestamp - a.timestamp)
      return ok(list)
    },
    dir: async (): Promise<ApiResponse<string>> => ok('（浏览器预览模式无本地日志目录）'),
    openDir: async (): Promise<ApiResponse<OperationResult>> =>
      ok({ ok: true, message: '预览模式不打开目录' }),
    /**
     * 错误落盘的浏览器模式对齐：无文件系统，console 留痕 +
     * sessionStorage 存 20 条（与 main.ts errorHandler 的旧兜底同源），
     * CDP / 排查时翻 sessionStorage 也能看到与产品一致的错误流。
     */
    reportError: async (report: ErrorReport): Promise<ApiResponse<OperationResult>> => {
      console.error(
        `[错误日志] [${report.source}] ${report.message}${report.stack ? '\n' + report.stack : ''}`,
      )
      try {
        const KEY = 'redisdesktop:error-reports'
        const list = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as ErrorReport[]
        list.unshift({ ...report, stack: report.stack?.slice(0, 2000) })
        sessionStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)))
      } catch {
        /* sessionStorage 不可用不影响主流程 */
      }
      return ok({ ok: true, message: '预览模式已记录到控制台' })
    },
  },

  file: {
    saveText: async (options: { suggestedName?: string; content: string }) => {
      await delay(120)
      // 浏览器环境用下载方式模拟主进程的保存对话框
      try {
        const blob = new Blob([options.content], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = options.suggestedName || 'value.txt'
        link.click()
        URL.revokeObjectURL(url)
        return ok({ saved: true, path: '（浏览器预览：已触发下载）' })
      } catch {
        return ok({ saved: false })
      }
    },
  },

  connection: {
    list: async () => {
      await delay(60)
      return ok(CONNECTIONS)
    },
    /**
     * 保存连接：真写回 CONNECTIONS（新增或覆盖同名 id）。
     *
     * 原实现只返回 [...CONNECTIONS, config] 的副本、不改数据源 ——
     * 保存后 bootstrap() 重新 list() 拿到的仍是旧列表，
     * 界面表现为"点了仅保存，弹窗关了但连接没出现"。
     * 与 remove 的教训同源：演示性返回会让闭环验证形同虚设。
     */
    save: async (config: CacheConnectionConfig) => {
      const index = CONNECTIONS.findIndex((item) => item.id === config.id)
      if (index >= 0) CONNECTIONS[index] = { ...CONNECTIONS[index], ...config }
      else CONNECTIONS.push({ ...config })
      return ok([...CONNECTIONS])
    },
    remove: async (id: string) => {
      // 与真实实现对齐：删除连接时清掉其全部历史桶（所有 db）
      const data = loadMockHistory()
      for (const key of Object.keys(data)) {
        if (key.startsWith(`${id}@`)) delete data[key]
      }
      saveMockHistory(data)
      /*
       * 真实删除 CONNECTIONS 元素（2026-10 批量删除需求）：原先是演示性
       * filter 返回（列表永远不变），置顶/排序同款教训 —— 单删走 UI 菜单
       * 时 CDP 断言只看 toast 没暴露；批量删除要验「列表真的变短」，
       * 假实现会让闭环验证形同虚设。同时清掉 order 持久化里的残留 id
       * （下次模块加载按旧 order 重排时，已删 id 不应再出现）。
       */
      const index = CONNECTIONS.findIndex((item) => item.id === id)
      if (index >= 0) CONNECTIONS.splice(index, 1)
      try {
        const order = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]') as string[]
        if (order.includes(id)) {
          localStorage.setItem(ORDER_KEY, JSON.stringify(order.filter((x) => x !== id)))
        }
      } catch {
        /* localStorage 不可用不影响删除主流程 */
      }
      return ok(CONNECTIONS.filter((item) => item.id !== id))
    },
    // 置顶必须真实变更 CONNECTIONS：save/remove 在 mock 里只是演示性返回，
    // 但置顶要看得到排序变化，list 返回时才能反映出来（CDP 验证依赖这一点）
    setPinned: async (id: string, pinned: boolean) => {
      const target = CONNECTIONS.find((item) => item.id === id)
      if (target) target.pinned = pinned || undefined
      return ok(CONNECTIONS)
    },
    // 拖拽排序：真实重排数组 + localStorage 落盘，刷新页面（模拟重启）后顺序保留
    reorder: async (ids: string[]) => {
      const byId = new Map(CONNECTIONS.map((item) => [item.id, item]))
      const ordered = ids.map((id) => byId.get(id)).filter((item): item is CacheConnectionConfig => !!item)
      for (const item of CONNECTIONS) if (!ids.includes(item.id)) ordered.push(item)
      CONNECTIONS.splice(0, CONNECTIONS.length, ...ordered)
      try {
        localStorage.setItem(ORDER_KEY, JSON.stringify(ordered.map((item) => item.id)))
      } catch {
        /* 落盘失败不影响本次会话内的排序 */
      }
      return ok(CONNECTIONS)
    },
    test: async () => {
      await delay(420)
      return ok({ ok: true, message: '连接成功 · Redis 7.2.4 · 2ms' })
    },
    // 浏览器预览没有主进程推送，订阅为 no-op（返回取消函数）
    onStatusChange: () => () => {},
    connect: async (config: CacheConnectionConfig): Promise<ApiResponse<ConnectionState>> => {
      await delay(360)
      /*
       * 按引擎分流：返回的状态形状必须与该引擎的子类型一致。
       * 两个分支各自挑字段，不做 {...config} 展开 ——
       * 否则 Redis 的 db / Memcached 的 poolSize 会互相串到对方状态里，
       * 界面上就会出现"Memcached 连上后还显示 db0"这类脏数据。
       */
      if (config.engine === 'memcached') {
        return ok({
          id: config.id,
          name: config.name,
          engine: 'memcached',
          host: config.host,
          port: config.port,
          poolSize: config.poolSize ?? 4,
          sshEnabled: !!(config.sshEnabled && config.ssh),
          sshHost: config.sshEnabled && config.ssh ? config.ssh.host : undefined,
          status: 'connected',
          latency: 1,
          version: '1.6.21',
        })
      }
      // 记录当前版本，后续 info / TTL 相关接口按此返回
      activeVersion = versionOf(config.id)
      /*
       * 与主进程 connect 的 identity 同构：只挑字段，不做 {...config} 全展开。
       * 曾用全展开让 pinned/ssh 意外"顺带"保留，掩盖了主进程挑字段漏传
       * （连接成功置顶丢失）——mock 必须对齐真实实现的字段集，
       * 渲染端的补回逻辑（useRedis.connect 合并 pinned/ssh）才能被 CDP 验证到。
       */
      return ok({
        id: config.id,
        name: config.name,
        engine: 'redis',
        host: config.host,
        port: config.port,
        username: config.username,
        db: config.db,
        tls: config.tls,
        sshEnabled: config.sshEnabled && !!config.ssh,
        status: 'connected',
        latency: 2,
        version: activeVersion,
        mode: 'standalone',
      })
    },
    disconnect: async (): Promise<ApiResponse<OperationResult>> => {
      /* 对齐主进程：断开时一并清掉 Pub/Sub 订阅状态（不留幽灵订阅） */
      PUBSUB_SUBS.clear()
      return ok({ ok: true })
    },
    status: async () => ok(true),
  },

  redis: {
    info: async () => {
      await delay(180)
      return ok({ ...SERVER_INFO, version: activeVersion })
    },
    versionInfo: async (): Promise<ApiResponse<VersionInfo>> => {
      await delay(200)
      return ok({
        version: activeVersion,
        mode: SERVER_INFO.mode,
        groups: [
          {
            section: 'Server',
            entries: [
              { key: 'redis_version', value: SERVER_INFO.version },
              { key: 'redis_git_sha1', value: 'c6f9e1a4' },
              { key: 'redis_git_dirty', value: '0' },
              { key: 'redis_build_id', value: 'a1b2c3d4e5f60718' },
              { key: 'redis_mode', value: SERVER_INFO.mode },
              { key: 'os', value: SERVER_INFO.os },
              { key: 'arch_bits', value: '64' },
              { key: 'process_id', value: String(SERVER_INFO.processId) },
              { key: 'run_id', value: '7f3c9a12b8e44d0fa5c6d1e29b3f8a70c4d5e612' },
              { key: 'tcp_port', value: '6379' },
              { key: 'uptime_in_days', value: String(SERVER_INFO.uptimeInDays) },
              { key: 'config_file', value: '/etc/redis/redis.conf' },
            ],
          },
          {
            section: 'Clients',
            entries: [
              { key: 'connected_clients', value: String(SERVER_INFO.connectedClients) },
              { key: 'maxclients', value: '10000' },
              { key: 'blocked_clients', value: '0' },
            ],
          },
          {
            section: 'Memory',
            entries: [
              { key: 'used_memory_human', value: SERVER_INFO.usedMemoryHuman },
              { key: 'used_memory_lua_human', value: SERVER_INFO.usedMemoryLua },
              { key: 'used_memory_peak_human', value: '256.18M' },
              { key: 'maxmemory_human', value: '2.00G' },
              { key: 'maxmemory_policy', value: 'allkeys-lru' },
              { key: 'mem_fragmentation_ratio', value: '1.12' },
              { key: 'mem_allocator', value: 'jemalloc-5.3.0' },
            ],
          },
          {
            section: 'Stats',
            entries: [
              { key: 'total_connections_received', value: '128442' },
              { key: 'total_commands_processed', value: '9824410' },
              { key: 'instantaneous_ops_per_sec', value: String(SERVER_INFO.opsPerSec) },
              { key: 'keyspace_hits', value: '8912440' },
              { key: 'keyspace_misses', value: '118764' },
              { key: 'expired_keys', value: '48210' },
              { key: 'evicted_keys', value: '1204' },
            ],
          },
          {
            section: 'Replication',
            entries: [
              { key: 'role', value: 'master' },
              { key: 'connected_slaves', value: '1' },
              { key: 'repl_backlog_active', value: '1' },
            ],
          },
          {
            section: 'Keyspace',
            entries: [
              { key: 'db0', value: 'keys=1284,expires=182,avg_ttl=1842000' },
              { key: 'db2', value: 'keys=316,expires=94,avg_ttl=924000' },
            ],
          },
        ],
        raw:
          '# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n' +
          `os:${SERVER_INFO.os}\r\nuptime_in_days:${SERVER_INFO.uptimeInDays}\r\n`,
      })
    },
    databases: async () => ok(DATABASES),
    slowlog: async (): Promise<ApiResponse<SlowlogOverview>> => {
      await delay(140)
      /* 与真实实现一致：RESET 后 len 与 entries 同步归零 */
      return ok({ len: SLOWLOG.length, entries: SLOWLOG.map((item) => ({ ...item, command: [...item.command] })) })
    },
    /*
     * mock 契约：RESET 真清空 SLOWLOG，清空后再次查询必须返回空 ——
     * 「清空按钮真的生效」这一行为只有 mock 持久化状态才能在 CDP 里验证。
     */
    slowlogReset: async (): Promise<ApiResponse<OperationResult>> => {
      await delay(80)
      SLOWLOG.length = 0
      return ok({ ok: true, message: '慢查询日志已清空' })
    },
    /*
     * mock 契约：与主进程共用 shared/keyspace 的 memoryPrefixOf
     * （聚合口径两处各写一套必然漂移）；字节数走确定公式，
     * 「某前缀共多少键、多少字节」可以被 CDP 精确断言。
     * mock 键量远低于扫描上限，truncated 恒 false（截断行为靠静态断言把关）。
     */
    memoryAnalysis: async (_id: string, depth = 1): Promise<ApiResponse<MemoryAnalysis>> => {
      await delay(200)
      const level = Math.min(Math.max(Math.floor(depth) || 1, 1), 4)
      const buckets = new Map<string, MemoryBucket>()
      let totalBytes = 0
      for (const item of KEYS) {
        const bytes = (MOCK_MEMORY_BASE[item.type] ?? 64) + item.key.length
        const prefix = memoryPrefixOf(item.key, level)
        const bucket = buckets.get(prefix) ?? { prefix, keys: 0, bytes: 0 }
        bucket.keys += 1
        bucket.bytes += bytes
        buckets.set(prefix, bucket)
        totalBytes += bytes
      }
      /* 桶上限与主进程同款截断（mock 键量恒低于 200，永不触发，行为靠静态断言把关） */
      const sorted = [...buckets.values()].sort((a, b) => b.bytes - a.bytes || a.prefix.localeCompare(b.prefix))
      const bucketsTruncated = sorted.length > MEMORY_BUCKET_LIMIT
      return ok({
        depth: level,
        scanned: KEYS.length,
        truncated: false,
        bucketsTruncated,
        totalBytes,
        buckets: bucketsTruncated ? sorted.slice(0, MEMORY_BUCKET_LIMIT) : sorted,
      })
    },
    /*
     * Pub/Sub mock：订阅状态真实记录（重复订阅幂等跳过），
     * publish 按「精确命中 or 模式命中」计算接收者并回声推送。
     */
    pubsubSubscribe: async (id: string, targets: string[], pattern = false): Promise<ApiResponse<PubsubState>> => {
      await delay(60)
      let subs = PUBSUB_SUBS.get(id)
      if (!subs) {
        subs = { channels: new Set(), patterns: new Set() }
        PUBSUB_SUBS.set(id, subs)
      }
      for (const target of targets) {
        const name = target.trim()
        if (name) (pattern ? subs.patterns : subs.channels).add(name)
      }
      return ok(pubsubStateOf(id))
    },
    pubsubUnsubscribe: async (id: string, targets: string[], pattern = false): Promise<ApiResponse<PubsubState>> => {
      await delay(60)
      const subs = PUBSUB_SUBS.get(id)
      if (subs) {
        for (const target of targets) {
          const name = target.trim()
          if (name) (pattern ? subs.patterns : subs.channels).delete(name)
        }
      }
      return ok(pubsubStateOf(id))
    },
    pubsubPublish: async (id: string, channel: string, message: string): Promise<ApiResponse<number>> => {
      await delay(60)
      const subs = PUBSUB_SUBS.get(id)
      const channelHit = !!subs?.channels.has(channel)
      const hitPattern = subs ? [...subs.patterns].find((p) => globToRegExp(p).test(channel)) : undefined
      if (!subs || (!channelHit && !hitPattern)) return ok(0)
      const kind: PubsubMessage['kind'] = channelHit ? 'message' : 'pmessage'
      const pattern = channelHit ? '' : (hitPattern ?? '')
      const payload: PubsubMessage = { connectionId: id, kind, channel, pattern, payload: message, timestamp: Date.now() }
      /* 回声延迟模拟真实网络往返，也让界面能演示「先发布后到达」的过程 */
      setTimeout(() => {
        for (const listener of pubsubListeners) listener(payload)
      }, 80)
      return ok(1)
    },
    pubsubStop: async (id: string): Promise<ApiResponse<OperationResult>> => {
      await delay(40)
      PUBSUB_SUBS.delete(id)
      return ok({ ok: true })
    },
    onPubsubMessage: (listener: (message: PubsubMessage) => void): (() => void) => {
      pubsubListeners.add(listener)
      return () => {
        pubsubListeners.delete(listener)
      }
    },
    scan: async (_id: string, options): Promise<ApiResponse<ScanResult>> => {
      await delay(150)
      const match = options?.match?.trim()
      let list = KEYS
      if (match && match !== '*') {
        /*
         * 与真实 Redis glob 语义对齐：
         * 无通配符 → 精确匹配（对应精确模式转义后的键名）；
         * 含 * → 子串包含（对应模糊模式的 *kw* 包夹）。
         */
        list = match.includes('*')
          ? KEYS.filter((item) => item.key.includes(match.replace(/\*/g, '')))
          : KEYS.filter((item) => item.key === match)
      }
      return ok({
        cursor: '0',
        db: options?.db ?? 0,
        keys: list.map((item) => ({ ...item })),
      })
    },
    lookupKey: async (_id: string, key: string): Promise<ApiResponse<RedisKeyItem | null>> => {
      await delay(60)
      const found = KEYS.find((item) => item.key === key)
      return ok(found ? { ...found } : null)
    },
    /*
     * 全库搜索：SCAN 循环下沉主进程后的渲染层新入口。
     * mock 对齐三件事：glob 语义与 scan 一致（*kw* → 子串包含）、
     * limit 截断 capped、取消令牌（searchCancel 递增，这里检查后返回部分结果）。
     */
    searchAll: async (
      id: string,
      options?: SearchAllOptions,
    ): Promise<ApiResponse<SearchAllResult>> => {
      const match = options?.match?.trim() || '*'
      const limit = Math.min(Math.max(options?.limit ?? 1000, 1), 1000)
      const token = (searchTokens.get(id) ?? 0) + 1
      searchTokens.set(id, token)
      const matched =
        match === '*'
          ? KEYS
          : match.includes('*')
            ? KEYS.filter((item) => item.key.includes(match.replace(/\*/g, '')))
            : KEYS.filter((item) => item.key === match)

      // 第一段延迟：扫描进行中，推一次进度（渲染层「已找到 N 条」的数据源）
      await delay(100)
      if (searchTokens.get(id) === token) {
        emitSearchProgress({ connectionId: id, found: Math.ceil(matched.length / 2) })
      }
      await delay(160)

      // 令牌失效（停止/新搜索/断开）：返回已找到的前一半 + cancelled，对齐真实取消语义
      if (searchTokens.get(id) !== token) {
        const half = matched.slice(0, Math.ceil(matched.length / 2))
        return ok({ keys: half.map((item) => ({ ...item })), capped: false, cancelled: true })
      }

      const capped = matched.length > limit
      const keys = (capped ? matched.slice(0, limit) : matched).map((item) => ({ ...item }))
      emitSearchProgress({ connectionId: id, found: keys.length })
      return ok({ keys, capped, cancelled: false })
    },
    searchCancel: async (id: string): Promise<ApiResponse<OperationResult>> => {
      searchTokens.set(id, (searchTokens.get(id) ?? 0) + 1)
      return ok({ ok: true })
    },
    onSearchProgress: (listener: (progress: SearchProgress) => void): (() => void) => {
      searchProgressListeners.add(listener)
      return () => {
        searchProgressListeners.delete(listener)
      }
    },
    value: async (_id: string, key: string) => {
      await delay(120)
      return ok(mockValue(key))
    },
    setValue: async (): Promise<ApiResponse<OperationResult>> => {
      await delay(180)
      return ok({ ok: true, message: '已保存（预览模式不落库）' })
    },
    remove: async (_id: string, keys: string[]): Promise<ApiResponse<OperationResult>> =>
      ok({ ok: true, message: `已删除 ${keys.length} 个键` }),
    /*
     * mock 契约：真实实现会改库（EXPIRE / PERSIST），mock 必须真实改 KEYS，
     * 否则批量设置 TTL 的 CDP 验证全是假通过（与置顶 / 连接排序同款教训）。
     */
    setTtl: async (_id: string, key: string, seconds: number): Promise<ApiResponse<OperationResult>> => {
      await delay(80)
      const target = KEYS.find((item) => item.key === key)
      if (!target) return { ok: false, error: `键 ${key} 已不存在` }
      target.ttl = seconds <= 0 ? -1 : seconds
      return ok({ ok: true, message: seconds <= 0 ? '已设置为永久' : `TTL 已设置为 ${seconds}s` })
    },
    /*
     * mock 契约：真实实现带「目标键已存在则拒绝」的防覆盖防线，mock 对齐 ——
     * 批量重命名的失败路径（冲突跳过）全靠这里才能在 CDP 里验证。
     */
    rename: async (
      _id: string,
      key: string,
      newKey: string,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(80)
      const target = KEYS.find((item) => item.key === key)
      if (!target) return { ok: false, error: `键 ${key} 已不存在` }
      if (KEYS.some((item) => item.key === newKey)) {
        return { ok: false, error: `目标键 ${newKey} 已存在，重命名会覆盖它，已拒绝执行` }
      }
      target.key = newKey
      return ok({ ok: true, message: '已重命名' })
    },
    delHashField: async (
      _id: string,
      key: string,
      field: string,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(160)
      const target = HASHS[key]
      if (!target || !(field in target)) return { ok: false, error: `字段 ${field} 不存在` }
      delete target[field]
      return ok({ ok: true, message: `已删除字段 ${field}` })
    },
    setHashField: async (
      _id: string,
      key: string,
      field: string,
      value: string,
      nextField?: string,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(180)
      const target = HASHS[key]
      if (!target) return { ok: false, error: `键 ${key} 已不存在` }
      const name = (nextField ?? field).trim()
      if (!name) return { ok: false, error: '字段名不能为空' }
      if (name !== field) {
        delete target[field]
        target[name] = value
        return ok({ ok: true, message: `已重命名为 ${name}` })
      }
      target[name] = value
      return ok({ ok: true, message: `已更新字段 ${name}` })
    },
    /**
     * 读取 hash 字段 TTL。
     * 低版本连接（< 7.4）返回 null，模拟真实的 unknown command ——
     * 界面据此判定能力不可用，与 Electron 环境行为保持一致。
     */
    hashFieldTtls: async (
      _id: string,
      key: string,
      fields: string[],
    ): Promise<ApiResponse<Record<string, number> | null>> => {
      await delay(90)
      if (!supportsFieldTtl(_id)) return ok(null)

      const target = HASHS[key]
      if (!target) return ok(null)

      const preset = HASH_FIELD_TTLS[key] ?? {}
      const result: Record<string, number> = {}
      for (const field of fields) {
        if (!(field in target)) {
          result[field] = -2
          continue
        }
        // 有预设用预设，否则视为永久字段
        result[field] = preset[field] ?? -1
      }
      return ok(result)
    },
    setHashFieldTtl: async (
      _id: string,
      key: string,
      field: string,
      seconds: number,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(150)
      if (!supportsFieldTtl(_id)) {
        return { ok: false, error: '当前服务端不支持字段级 TTL，需要 Redis 7.4 及以上版本' }
      }
      const target = HASHS[key]
      if (!target || !(field in target)) return { ok: false, error: `字段 ${field} 不存在` }

      // 写回模拟表，刷新后可见变化
      if (!HASH_FIELD_TTLS[key]) HASH_FIELD_TTLS[key] = {}
      HASH_FIELD_TTLS[key][field] = seconds > 0 ? seconds : -1

      return ok({
        ok: true,
        message: seconds > 0 ? `字段 ${field} 的 TTL 已设置为 ${seconds}s` : `已清除字段 ${field} 的过期时间`,
      })
    },
    setListElement: async (
      _id: string,
      key: string,
      index: number,
      value: string,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(150)
      const list = LISTS[key]
      if (!list) return { ok: false, error: `键 ${key} 已不存在` }
      if (index < 0 || index >= list.length) return { ok: false, error: '该位置已不存在' }
      list[index] = value
      return ok({ ok: true, message: `已更新第 ${index + 1} 项` })
    },
    delListElement: async (
      _id: string,
      key: string,
      index: number,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(150)
      const list = LISTS[key]
      if (!list) return { ok: false, error: `键 ${key} 已不存在` }
      if (index < 0 || index >= list.length) return { ok: false, error: '该位置已不存在' }
      list.splice(index, 1)
      const left = list.length
      return ok({
        ok: true,
        message: left ? `已删除第 ${index + 1} 项` : `已删除第 ${index + 1} 项（列表已空，键随之移除）`,
      })
    },
    appendListElement: async (
      _id: string,
      key: string,
      value: string,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(150)
      if (!LISTS[key]) LISTS[key] = []
      LISTS[key].push(value)
      return ok({ ok: true, message: `已追加到末尾（共 ${LISTS[key].length} 项）` })
    },
    insertListElement: async (
      _id: string,
      key: string,
      index: number,
      value: string,
      position: 'before' | 'after',
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(150)
      const list = LISTS[key]
      if (!list) return { ok: false, error: `键 ${key} 已不存在` }
      if (index < 0 || index >= list.length) return { ok: false, error: '基准位置已不存在' }
      list.splice(position === 'before' ? index : index + 1, 0, value)
      return ok({ ok: true, message: `已在第 ${index + 1} 项${position === 'before' ? '前' : '后'}插入` })
    },
    setSetMember: async (
      _id: string,
      key: string,
      member: string,
      next: string,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(150)
      const set = SETS[key]
      if (!set) return { ok: false, error: `键 ${key} 已不存在` }
      const target = next.trim()
      if (!target) return { ok: false, error: '成员内容不能为空' }
      if (target === member) return ok({ ok: true, message: '内容未发生变化' })

      const index = set.indexOf(member)
      if (index < 0) return { ok: false, error: `成员 ${member} 不存在` }
      const existed = set.includes(target)
      set.splice(index, 1)
      if (!existed) set.push(target)

      return ok({
        ok: true,
        message: existed ? `已删除成员 ${member}（${target} 原本已存在）` : `已将 ${member} 改为 ${target}`,
      })
    },
    delSetMember: async (
      _id: string,
      key: string,
      member: string,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(150)
      const set = SETS[key]
      if (!set) return { ok: false, error: `键 ${key} 已不存在` }
      const index = set.indexOf(member)
      if (index < 0) return { ok: false, error: `成员 ${member} 不存在` }
      set.splice(index, 1)
      return ok({
        ok: true,
        message: set.length ? `已删除成员 ${member}` : `已删除成员 ${member}（集合已空，键随之移除）`,
      })
    },
    addSetMember: async (
      _id: string,
      key: string,
      member: string,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(150)
      const target = member.trim()
      if (!target) return { ok: false, error: '成员内容不能为空' }
      if (!SETS[key]) SETS[key] = []
      const set = SETS[key]
      if (set.includes(target)) return ok({ ok: true, message: `成员 ${target} 已存在，未重复添加` })
      set.push(target)
      return ok({ ok: true, message: `已添加成员 ${target}（共 ${set.length} 个）` })
    },
    setZsetMember: async (
      _id: string,
      key: string,
      member: string,
      nextMember: string,
      nextScore: number,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(150)
      const list = ZSETS[key]
      if (!list) return { ok: false, error: `键 ${key} 已不存在` }
      const target = nextMember.trim()
      if (!target) return { ok: false, error: '成员内容不能为空' }
      if (!Number.isFinite(nextScore)) return { ok: false, error: 'score 必须是数字' }

      const index = list.findIndex((item) => splitPairMock(item)[0] === member)
      if (index < 0) return { ok: false, error: `成员 ${member} 不存在` }

      if (target === member) {
        list[index] = `${member} :: ${nextScore}`
        return ok({ ok: true, message: `已更新 ${target} 的 score 为 ${nextScore}` })
      }

      const conflict = list.findIndex((item) => splitPairMock(item)[0] === target)
      if (conflict >= 0) {
        list.splice(conflict, 1)
        const at = list.findIndex((item) => splitPairMock(item)[0] === member)
        if (at >= 0) list.splice(at, 1)
        list.push(`${target} :: ${nextScore}`)
        return ok({
          ok: true,
          message: `已移除 ${member}（${target} 原本已存在，score 已更新为 ${nextScore}）`,
        })
      }

      list[index] = `${target} :: ${nextScore}`
      return ok({ ok: true, message: `已将 ${member} 改为 ${target}（score ${nextScore}）` })
    },
    delZsetMember: async (
      _id: string,
      key: string,
      member: string,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(150)
      const list = ZSETS[key]
      if (!list) return { ok: false, error: `键 ${key} 已不存在` }
      const index = list.findIndex((item) => splitPairMock(item)[0] === member)
      if (index < 0) return { ok: false, error: `成员 ${member} 不存在` }
      list.splice(index, 1)
      return ok({
        ok: true,
        message: list.length ? `已删除成员 ${member}` : `已删除成员 ${member}（集合已空，键随之移除）`,
      })
    },
    addZsetMember: async (
      _id: string,
      key: string,
      member: string,
      score: number,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(150)
      const target = member.trim()
      if (!target) return { ok: false, error: '成员内容不能为空' }
      if (!Number.isFinite(score)) return { ok: false, error: 'score 必须是数字' }
      if (!ZSETS[key]) ZSETS[key] = []
      const list = ZSETS[key]
      const index = list.findIndex((item) => splitPairMock(item)[0] === target)
      if (index >= 0) {
        list[index] = `${target} :: ${score}`
        return ok({ ok: true, message: `成员 ${target} 已存在，score 已更新为 ${score}` })
      }
      list.push(`${target} :: ${score}`)
      return ok({ ok: true, message: `已添加成员 ${target}（共 ${list.length} 个）` })
    },
    /**
     * XADD 追加（真实写 STREAMS：生成「大于最后一条」的 ID 并追加，
     * 行格式 `id :: field=value` —— 本地更新与 CDP 断言都依赖真实落库）。
     */
    xaddEntry: async (
      _id: string,
      key: string,
      field: string,
      value: string,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(160)
      const target = field.trim()
      if (!target) return { ok: false, error: '字段名不能为空' }
      if (!STREAMS[key]) STREAMS[key] = []
      const list = STREAMS[key]
      /* ID 单调递增：取末条时间戳 +1（列表本身按 ID 升序渲染）；空流从当前时间起 */
      const lastId = list.length ? (list[list.length - 1].split(' :: ')[0] ?? '0-0') : '0-0'
      const lastMs = Number(lastId.split('-')[0]) || Date.now()
      const entryId = `${Math.max(lastMs + 1, Date.now())}-0`
      list.push(`${entryId} :: ${target}=${value}`)
      return ok({ ok: true, message: `已追加消息 ${entryId}` })
    },
    createKey: async (
      _id: string,
      key: string,
      type: RedisValueType,
      payload?: string | string[] | Record<string, string>,
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(200)
      if (KEYS.some((item) => item.key === key)) {
        return { ok: false, error: `键 ${key} 已存在` }
      }
      if (type !== 'string') {
        const isEmpty =
          type === 'hash'
            ? Object.keys((payload as Record<string, string>) ?? {}).length === 0
            : ((payload as string[]) ?? []).length === 0
        if (isEmpty) return { ok: false, error: `${type} 类型至少需要一个元素才能落库` }
      }
      return ok({ ok: true, message: `已创建 ${key}` })
    },
    cli: async (_id: string, command: string): Promise<ApiResponse<CliResult>> => {
      await delay(160)
      const head = command.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
      if (CLI_HISTORY[head]) return ok(CLI_HISTORY[head])
      if (head === 'get') {
        const key = command.trim().split(/\s+/)[1] ?? ''
        return ok({ output: STRINGS[key] ?? '(nil)', costMs: 1 })
      }
      return ok({ output: '(error) ERR 预览模式仅支持 PING / INFO / DBSIZE / GET', costMs: 1 })
    },
  },

  /*
   * Memcached 预览数据。
   *
   * 刻意不与上面 redis 的演示数据共用任何变量 ——
   * 浏览器预览里也要能验证"两个模块互不干扰"：
   * 在 Memcached 面板里写入一个键，Redis 的键列表不应出现它。
   */
  memcached: {
    overview: async (id: string): Promise<ApiResponse<MemcachedOverview>> => {
      await delay(180)
      if (!MOCK_MC_KEYS[id]) MOCK_MC_KEYS[id] = seedMemcached()
      const store = MOCK_MC_KEYS[id]!
      const totalBytes = [...store.values()].reduce((sum, item) => sum + utf8Bytes(item.data), 0)
      const hits = 48_213
      const misses = 1_642
      return ok({
        version: '1.6.21',
        items: aggregateSlabs(store),
        settings: {
          maxbytes: '268435456',
          maxconns: '1024',
          tcpport: '11211',
          num_threads: '4',
          evictions: 'on',
          growth_factor: '1.25',
        },
        stats: {
          pid: '2841',
          uptime: String(60 * 60 * 26 + 812),
          time: String(Math.floor(Date.now() / 1000)),
          version: '1.6.21',
          threads: '4',
          curr_connections: '37',
          total_connections: '1284',
          cmd_get: String(hits + misses),
          cmd_set: '9214',
          get_hits: String(hits),
          get_misses: String(misses),
          curr_items: String(store.size),
          total_items: '18422',
          bytes: String(totalBytes),
          limit_maxbytes: '268435456',
          evictions: '0',
          reclaimed: '412',
        },
      })
    },

    slabs: async (id: string): Promise<ApiResponse<MemcachedSlab[]>> => {
      await delay(120)
      if (!MOCK_MC_KEYS[id]) MOCK_MC_KEYS[id] = seedMemcached()
      /*
       * aggregateSlabs 为每个 slab 输出三个键（:number / :age / :evicted）。
       * 直接 map 会把同一个 slab 产出三次 —— React 报"重复 key"，
       * 表格里也会出现三行一样的 slab。必须按 slab 编号去重合并。
       * 真实主进程实现（memcachedManager.slabs）用的是 Map 聚合，
       * 天然不会重复；mock 这里要与它对齐。
       */
      const groups = aggregateSlabs(MOCK_MC_KEYS[id]!)
      const bySlab = new Map<number, MemcachedSlab>()
      for (const [key, value] of Object.entries(groups)) {
        const match = /^items:(\d+):(\w+)$/.exec(key)
        if (!match) continue
        const slab = Number(match[1])
        const field = match[2]
        if (!Number.isFinite(slab)) continue
        const entry = bySlab.get(slab) ?? { slab, count: 0, age: 240, evicted: 0 }
        if (field === 'number') entry.count = Number(value) || 0
        else if (field === 'age') entry.age = Number(value) || 240
        else if (field === 'evicted') entry.evicted = Number(value) || 0
        bySlab.set(slab, entry)
      }
      return ok([...bySlab.values()].filter((item) => item.count > 0).sort((a, b) => a.slab - b.slab))
    },

    keys: async (id: string, options?: { perSlab?: number }): Promise<ApiResponse<MemcachedKeyList>> => {
      await delay(320)
      if (!MOCK_MC_KEYS[id]) MOCK_MC_KEYS[id] = seedMemcached()
      const store = MOCK_MC_KEYS[id]!
      const perSlab = options?.perSlab ?? 500
      const items = [...store.entries()].map(([key, item]) => ({
        key,
        bytes: utf8Bytes(item.data),
        expiresAt: item.expiresAt,
        slab: 1,
      }))
      return ok({
        items: items.slice(0, perSlab),
        truncated: items.length > perSlab,
        deniedSlabs: [],
      })
    },

    get: async (id: string, key: string): Promise<ApiResponse<MemcachedValue>> => {
      await delay(90)
      const store = MOCK_MC_KEYS[id] ?? (MOCK_MC_KEYS[id] = seedMemcached())
      const found = store.get(key)
      if (!found) return ok({ found: false, data: '', bytes: 0, flags: 0 })
      const now = Math.floor(Date.now() / 1000)
      return ok({
        found: true,
        data: found.data,
        bytes: utf8Bytes(found.data),
        flags: found.flags,
        ttl: found.expiresAt ? Math.max(0, found.expiresAt - now) : -1,
      })
    },

    set: async (
      id: string,
      key: string,
      value: string,
      options?: {
        exptime?: number
        mode?: 'set' | 'add' | 'replace'
        flags?: number
        ttlSeconds?: number
      },
    ): Promise<ApiResponse<OperationResult>> => {
      await delay(80)
      const store = MOCK_MC_KEYS[id] ?? (MOCK_MC_KEYS[id] = seedMemcached())
      const mode = options?.mode ?? 'set'
      if (mode === 'add' && store.has(key)) {
        return ok({ ok: false, message: '键已存在，未写入（add 语义）' })
      }
      if (mode === 'replace' && !store.has(key)) {
        return ok({ ok: false, message: '键不存在，未写入（replace 语义）' })
      }
      const ttl = options?.ttlSeconds
      const exptime = ttl !== undefined ? (ttl < 0 ? 0 : Math.max(1, ttl)) : options?.exptime ?? 0
      store.set(key, {
        data: value,
        flags: options?.flags ?? 0,
        expiresAt: exptime > 0 ? Math.floor(Date.now() / 1000) + exptime : 0,
      })
      return ok({ ok: true, message: '已保存' })
    },

    remove: async (id: string, key: string): Promise<ApiResponse<OperationResult>> => {
      await delay(70)
      const store = MOCK_MC_KEYS[id]
      if (!store || !store.delete(key)) return ok({ ok: false, message: '键不存在' })
      return ok({ ok: true, message: '已删除' })
    },

    rename: async (id: string, key: string, newKey: string): Promise<ApiResponse<OperationResult>> => {
      await delay(90)
      const store = MOCK_MC_KEYS[id] ?? (MOCK_MC_KEYS[id] = seedMemcached())
      const source = store.get(key)
      if (!source) return ok({ ok: false, message: '键已过期或被删除' })
      const target = newKey.trim()
      if (!target) return ok({ ok: false, message: '新的键名不能为空' })
      if (target === key) return ok({ ok: true, message: '键名未变化' })
      if (store.has(target)) {
        return ok({ ok: false, message: `目标键 ${target} 已存在，重命名会覆盖它，已拒绝执行` })
      }
      store.set(target, { ...source })
      store.delete(key)
      return ok({ ok: true, message: '已重命名' })
    },

    flush: async (id: string): Promise<ApiResponse<OperationResult>> => {
      await delay(200)
      MOCK_MC_KEYS[id] = new Map()
      return ok({ ok: true, message: '已清空全部数据' })
    },
  },
}

/* ---------------------------------------------------------------- Memcached 演示数据 */

interface MockMcItem {
  data: string
  flags: number
  /** 绝对过期时间（秒）；0 表示永不过期 */
  expiresAt: number
}

const MOCK_MC_KEYS: Record<string, Map<string, MockMcItem>> = {}

function seedMemcached(): Map<string, MockMcItem> {
  const now = Math.floor(Date.now() / 1000)
  const seed: Array<[string, string, number]> = [
    ['session:8f2a1c', '{"uid":1001,"role":"admin","loginAt":"2026-10-29T09:12:00Z"}', 1800],
    ['session:3b8d0f', '{"uid":2048,"role":"user","loginAt":"2026-10-29T10:03:11Z"}', 1800],
    ['cache:home:feed:zh', '[{"id":"a1","title":"今日推荐"},{"id":"a2","title":"热门榜单"}]', 600],
    ['cache:home:feed:en', '[{"id":"b1","title":"Recommended"},{"id":"b2","title":"Trending"}]', 600],
    ['user:1001:profile', '{"name":"林工","level":12,"avatar":"/a/1001.png"}', 3600],
    ['user:2048:profile', '{"name":"测试账号","level":3,"avatar":"/a/2048.png"}', 3600],
    ['rate:api:1001', '37', 60],
    ['rate:api:2048', '412', 60],
    ['lock:order:8842', '1', 30],
    ['feature:flags', '{"newCheckout":true,"darkMode":false,"betaSearch":true}', 0],
    ['config:site', '{"locale":"zh-CN","currency":"CNY","pageSize":20}', 0],
    ['hot:keywords', '缓存,Redis,Memcached,连接池,运维', 300],
  ]
  const map = new Map<string, MockMcItem>()
  for (const [key, data, ttl] of seed) {
    map.set(key, { data, flags: 0, expiresAt: ttl > 0 ? now + ttl : 0 })
  }
  return map
}

/** 把键集合聚合成 `items:<slab>:number` 形态，与真实 stats items 对齐 */
function aggregateSlabs(store: Map<string, MockMcItem>): Record<string, string> {
  const out: Record<string, string> = {}
  /* 演示用：按值长度粗略分到 3 个 slab，模拟真实的分档 */
  const buckets = new Map<number, number>()
  for (const [, item] of store) {
    const size = utf8Bytes(item.data)
    const slab = size <= 64 ? 1 : size <= 256 ? 2 : 3
    buckets.set(slab, (buckets.get(slab) ?? 0) + 1)
  }
  for (const [slab, count] of buckets) {
    out[`items:${slab}:number`] = String(count)
    out[`items:${slab}:age`] = '240'
    out[`items:${slab}:evicted`] = '0'
  }
  return out
}
