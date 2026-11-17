# Keyper (RedisDocter) 性能审查 · 文件分析

Route: C（file-only，仅项目源码；按用户任务范围不做外部检索）
Time Check: 2026-11-17 10:03 (UTC, shell `date`)
Constraints: 只读审查 E:\MyProject\RedisDocter 源码；不修改业务代码（本轮另行实现的两个 GitHub 入口 UI 需求不属于审查改动）；无外部搜索。
代码基线: git HEAD 38ef06d "chore(release): v1.1.4"（工作树含本轮新增的仓库入口 UI 改动，未提交）

## File Inventory（审查涉及的核心文件）

| File | Type | Size(行/字节) | Summary |
| --- | --- | --- | --- |
| electron/services/connection-manager.ts | TS 主进程 | 2451 行 | Redis 连接池、SCAN/搜索/取值/写入/Stream/CLI 全部数据链路 |
| electron/ipc/index.ts | TS 主进程 | 1254 行 | IPC 注册、通用 handle 包装（计时+操作日志）、事件广播 |
| electron/services/log-service.ts | TS 主进程 | 323 行 | 操作日志/错误日志同步落盘 |
| electron/services/settings-store.ts | TS 主进程 | 100 行 | settings.json 同步读写 |
| electron/services/engines/memcached/client.ts | TS 主进程 | 640 行 | Memcached 文本协议客户端（缓冲拼接/收齐判定） |
| electron/services/engines/memcached/pool.ts | TS 主进程 | 107 行 | 轮询连接池，瞬时错误重试一次 |
| electron/services/ssh-tunnel.ts | TS 主进程 | 524 行 | SSH 隧道，keepalive 10s×3 |
| electron/main.ts | TS 主进程 | 610 行 | 启动、CSP、窗口、异常落盘 |
| src/store/reactiveStore.ts | TS 渲染层 | 154 行 | Proxy 响应式 store，全局版本号订阅 |
| src/store/subscription.ts | TS 渲染层 | 22 行 | useSyncExternalStore 整树订阅 |
| src/store/session.ts | TS 渲染层 | 1763 行 | 会话动作：loadKeys/loadAll/批量任务/搜索 |
| src/store/useRedis.ts | TS 渲染层 | 276 行 | buildApi：每次组装新对象+bind 40 个动作 |
| src/components/KeyBrowser.tsx | TSX | 1759 行 | 键列表（树/平铺），平铺已虚拟化，树未虚拟化 |
| src/components/ValueViewer.tsx | TSX | 2895 行 | 六类型值区，VirtualRows 虚拟化，Activity 显隐 |
| src/components/VirtualRows.tsx | TSX | 272 行 | 自研可变行高虚拟滚动（ResizeObserver+前缀和+二分） |
| src/components/MetricsCard.tsx | TSX | 1021 行 | 2s 采样 INFO+DBSIZE，450 点环形裁剪 |
| src/components/PubsubCard.tsx | TSX | 315 行 | 每条消息 setState，200 条上限 |
| src/components/SlowlogCard.tsx | TSX | 1097 行 | 两个并存的 1s 定时器（相对时间 + 自动查询轮询） |
| src/hooks/valueEditor/string.ts | TS | 238 行 | prettyJson 每次渲染同步执行（未 memo） |
| src/hooks/useValueFormats.ts | TS | 169 行 | detectTextFormats 已 memo |
| src/utils/keyTree.ts | TS | 113 行 | 建树+递归排序（localeCompare numeric） |
| src/utils/format.ts | TS | 105 行 | utf8Bytes 已优化（TextEncoder+ASCII 快路径） |
| src/api/index.ts | TS | 76 行 | 所有 IPC 参数 JSON.parse(JSON.stringify) 双序列化 |
| src/services/settings.ts | TS | 145 行 | save() 全量 Object.assign 回写 → 多次 store emit |
| src/styles/components.css | CSS | 428 KB | 全应用手写样式单文件 |
| dist/assets/index-Dwty79QG.js | 构建产物 | 1.53 MB | 渲染层单 chunk（无代码分割） |
| dist/assets/index-D37dzd-g.css | 构建产物 | 346 KB | 单 CSS |
| vite.config.ts | 构建配置 | — | React Compiler 已启用；无 manualChunks |
| electron-builder.yml | 打包配置 | — | 已裁剪语言包、blockmap 增量更新 |

## Per-File Extraction（关键证据，行号为当前工作树）

### connection-manager.ts
- L58 `VALUE_PAGE_SIZE = 500`；L62 `REFRESH_SCAN_COUNT = 5000`。
- L427-445 心跳 `setInterval` 15s，`Promise.race([client.ping(), 3s 超时])` —— 竞速失败侧的 3s `setTimeout` 不清理；ping 挂起时该 promise 不结算。
- L523-527 / L607-611 connect/test 握手 PING+INFO pipeline（2 RTT，注释明示曾 3 RTT）。
- L735-745 `metrics()`：INFO+DBSIZE pipeline；`read(field)` 每字段 `new RegExp(...)` 对全文 INFO 扫描（每次采样约 17 个字段 × 全文正则）。
- L892-934 `memoryAnalysis`：SCAN COUNT 2000 + 每 100 键一个 MEMORY USAGE pipeline，`await` 串行；上限 10_000 键 → 约 100 次串行 RTT；无进度推送/取消令牌。
- L1169-1186 `describeKeys`：对 keys 全量 TYPE/TTL pipeline，不分片。
- L1288-1296 `searchAll`：SCAN COUNT 5000 循环，每批 `emitSearchProgress`（无节流）；令牌取消已实现。
- L1316-1352 `valueBinary`：`client.getBuffer(key)` 先取整值再截断到 4MB；`gunzipSync/inflateSync` 同步解压（maxOutputLength 上限 20MB）。
- L1390-1393 `getValue` string 分支：`client.get(key)` 整值无上限（注释自认「string 无法分页」）。
- L1626-1677 `setValue`：hash/list/set/zset 先 DEL 再整写（非原子、无 pipeline 包裹）；stream 分支 `for...await client.xadd` 逐条往返。
- L1689-1693 `deleteKeys`：`client.del(...keys)` 一次调用，无分片。
- L1877-1880 `addZsetMember`：EXISTS→ZSCORE→ZADD→ZCARD 4 次串行往返；L2159-2161 `addSetMember`、L2229-2231 `appendListElement` 同型 3 串行。
- L2179-2194 `deleteListElement`：LLEN→LINDEX→LSET→LREM→LLEN 5 串行；L2253-2263 `insertListElement` LINDEX→LSET→LINSERT→LSET 4 串行。
- L2322-2326 `renameKey`：EXISTS→RENAME 2 串行。

### ipc/index.ts
- L385-398 通用 handle 每次调用 `appendLog`（同步写盘）；L411-449 五类事件 `for (BrowserWindow.getAllWindows()) webContents.send` 广播（单窗口应用）。

### log-service.ts
- L126-139 `appendLog`：每次 `ensureDir()`(mkdirSync) + `fs.appendFileSync`。
- L185-211 `readLogs`：`fs.readFileSync` 整文件再逐行倒序解析（上限 5000 条）。
- L274-291 `appendErrorLog`：while existsSync+statSync 轮转探测 + appendFileSync + 每次 `pruneOldErrorLogs()`（L294-318 两次 readdirSync 全目录）。

### settings-store.ts
- L58-78 `loadSettings` 每次 existsSync+readFileSync+JSON.parse；L86-99 `saveSettings` 先 loadSettings 再 mkdirSync+writeFileSync 全量 JSON。

### memcached/client.ts
- L178-179 `onData`：`this.buffer = Buffer.concat([this.buffer, chunk])` 每 chunk 全量拷贝。
- L260-292 `untilEnd/untilEndLoose`：每次收包从 offset 0 `indexOf` 整个缓冲，无扫描起点记忆。

### 渲染层
- reactiveStore.ts L40-43/L82-101：任何字段写入 `emit()` 全体 listener；无路径级订阅（L107 注释自认「当前用整体失效即可」）。
- subscription.ts L20-22 + 各组件 `useObservable(useSessionStore())`（KeyBrowser L86、ValueViewer、MetricsCard L793 等 20+ 处）：会话任一字段变化 → 所有订阅组件重渲染。
- session.ts L570-587 `loadAll`：循环内逐键 `state.keys.push(...)`（每键一次 Proxy set→emit）；L497 `count: settings.pageSize`（默认 200）；LOAD_ALL_LIMIT=5000（L270）。
- session.ts L1170-1214 `runBulkTask`：逐键 `await api.redis.remove/setTtl/rename`，每键一次 IPC+主进程往返+操作日志写盘；无批量通道。
- useRedis.ts L76-118 `buildApi` 每次展开 sessionActions/globalActions、`pickSessionActions` bind ~40 函数；Workspace.tsx L36-37 每次渲染重建 → Context value 身份每次变化。
- KeyBrowser.tsx L351 `buildKeyTree` 已 memo；L1455+ 树形分支 `treeNodes.map(<KeyTreeNode>)` 全量渲染无虚拟化（平铺分支 L1503-1556 已有 FLAT_ROW_H=31 固定行高虚拟化）；KeyTreeNode.tsx L42 未包 React.memo（React Compiler 自动 memo 依赖 props 引用稳定，而回调多为内联新建）。
- keyTree.ts L73-81 `sortTree` 递归 `localeCompare('zh-CN',{numeric:true})`，每次比较构造 Intl collator 选项。
- string.ts L42 `const parsed = prettyJson(rawValue)` 未 memo —— ValueViewer 每次渲染同步 JSON.parse+stringify 全值；L153 `utf8Bytes(stringParsed.raw)` 同样每渲染执行。
- format.ts L57-73 注释记录历史实测：Blob 构造曾占 77% CPU（4 秒），已改 TextEncoder —— 项目有实测优化先例。
- api/index.ts L28-45 `sanitize`：所有 IPC 参数 `JSON.parse(JSON.stringify(value))`，preload invoke 再 toPlain 一次 → 双序列化。
- services/settings.ts L117/L123-133 `Object.assign(settings, ...)` 逐字段 set → N 次 emit；save 后主进程回读再 assign 一轮。
- MetricsCard.tsx L824-867 采样 effect 依赖 [active, connected, sampling, activeId, engine]，切页签即停表；L26 SAMPLE_INTERVAL_MS=2000，L28 MAX_SAMPLES=450。
- PubsubCard.tsx L103-113 每条消息一次 setMessages（无合帧）；L12 MAX_MESSAGES=200；KeyspaceCard 同型（L193-197）。
- SlowlogCard.tsx L506-523 两个并存的 1s setInterval（nowMs 刷新 + 自动查询轮询检查）。
- useTtlClock.ts 全文：共享 1s 时钟、无订阅者停表、document.hidden 停表 —— 已是良好实现。
- Workspace.tsx L9/L80-82 非激活标签 display:none 常驻不卸载；ValueViewer.tsx L550 值详情用 React `<Activity>` 控制显隐（隐藏时销毁 effect）。

### 构建/启动
- vite.config.ts：React Compiler target 19 已启用；build 无 manualChunks/懒加载；ioredis/ssh2/electron-updater external。
- dist/assets：单 JS 1,530,053 B + 单 CSS 346,455 B；mock.ts（2625 行）与全部组件打进同一 chunk。
- main.ts L354-389：show:false + backgroundColor + ready-to-show（防白屏已做）；sandbox:true、contextIsolation:true。
- electron-builder.yml：electronLanguages 裁剪 3 语言（注释：默认 50+ locale 约 41MB）；blockmap 增量更新已启用。
- src/styles/components.css 428KB 手写 CSS 全量加载，含大量 `.s-app.xxx, .s-app .xxx` 双形态选择器（体积翻倍主因之一）。

## Cross-File Mapping

1. **IPC 三重开销链**：渲染层 sanitize(JSON 双序列化) → preload toPlain → 主进程 handle 计时+appendLog 同步写盘。高频路径（loadAll 每页、批量任务每键、进度推送每批）全部踩满。
2. **store 广播链**：Proxy set → emit 全 listener → useObservable 整组件重渲染 → buildApi/Context 身份变化放大 → string.ts prettyJson 未 memo 在重渲染里重复解析大 JSON。
3. **主进程串行 RTT 链**：单键微操作（add/delete/insert/rename）3-5 次串行 await；批量任务在渲染层逐键循环。SSH 隧道下每 RTT 50-150ms（connection-manager L1147 注释实测口径）。
4. **无上限/同步阻塞点**：string GET 整值、gunzipSync 20MB、metadump Buffer.concat、memoryAnalysis 100 串行 RTT —— 都发生在主进程单线程，阻塞期间全应用 IPC 停摆。

## Gaps

- 未做运行时 profiling（本轮为静态审查+浏览器 mock 冒烟）；所有耗时收益为按 RTT/复杂度的推断，非实测。
- Memcached manager.ts 640 行仅抽查 keys/metadump 路径；ssh-tunnel.ts 仅核对 keepalive 参数。
- tests/e2e、scripts/*.cjs 探针未纳入审查范围（非交付代码）。

## Consolidated Themes

T1 主进程 Redis 命令往返合并与批量通道；T2 主进程事件循环阻塞点（同步 IO/解压/缓冲）；T3 渲染层订阅粒度与重渲染放大；T4 大值/大列表的渲染与传输上限；T5 构建产物体积与加载；T6 已做得好的部分（避免误报）。