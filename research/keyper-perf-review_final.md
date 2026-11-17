# Keyper (RedisDocter) 性能与优化审查清单

审查基线：git 38ef06d（v1.1.4）工作树 · 2026-11-17 · 静态源码审查（未做运行时 profiling，收益为 RTT/复杂度推断）
证据工件：`research/keyper-perf-review_*.md` + `keyper-perf-review_evidence.json`（30 条逐字源码摘录，行号可复核）

## 总评

项目已经过一轮扎实的性能优化：握手/监控/库列表命令 pipeline 合并、全库搜索下沉主进程、值区与平铺键列表虚拟化、共享 TTL 时钟、utf8Bytes 去 Blob 化、安装包语言裁剪、防白屏启动。**剩余问题集中在「每次交互都付税」的高频小操作**：单键微操作的串行往返、批量任务的逐键 IPC、主进程同步 IO/解压、渲染层全局订阅广播。以下 22 项按优先级排列，每项含位置、问题、建议与预期收益。

---

## P0 · 高优先（用户可直接感知的卡顿/风险）

### 1. string 大值无上限读取 —— 单个大键可拖死全应用
- 位置：`electron/services/connection-manager.ts` L1392（getValue）、L1322（valueBinary）
- 问题：`client.get(key)` / `getBuffer(key)` 一次取回整值（Redis string 上限 512MB），截断发生在取回**之后**；主进程内存、IPC 序列化、渲染层解析三处同时被撑爆。
- 建议：先 STRLEN 探测；超阈值（建议 2MB）改 GETRANGE 分段 + 界面「值过大，仅加载前 N 字节 / 加载更多」；valueBinary 直接 `GETRANGE 0..4MB-1` 限量取回。
- 收益：消除最大的单点崩溃/卡死风险；大键场景内存峰值从 O(值大小) 降到 O(页大小)。

### 2. gzip/zlib 同步解压阻塞主进程（最大 20MB 输出）
- 位置：`connection-manager.ts` L1343-1344（gunzipSync/inflateSync）；上限见 `shared/limits.ts` VALUE_DECODE_MAX_BYTES_CAP
- 问题：同步解压期间主进程事件循环完全停摆——**所有连接**的 IPC、心跳、状态推送一起卡。
- 建议：换 `zlib.gunzip` / `zlib.inflate` 异步版（libuv 线程池执行），保留 maxOutputLength。改动约 10 行。
- 收益：解压不再阻塞任何其他操作；改动最小、全局收益最确定的一项。

### 3. 单键微操作 3–5 次串行命令往返
- 位置：`connection-manager.ts` addZsetMember L1877-1880（EXISTS→ZSCORE→ZADD→ZCARD）、addSetMember L2159-2161、appendListElement L2229-2231、deleteListElement L2181-2194（5 次）、insertListElement L2253-2263（4 次）、setHashField L2294-2308、renameKey L2322-2326
- 问题：互不依赖的命令逐条 await。SSH 隧道下单程 50–150ms（项目注释实测口径），每点一次「添加成员/删除行」白等 2–4 个 RTT。
- 建议：pipeline 合并为 1 次往返；EXISTS 前置检查可并入同批按回复判断。renameKey 的防覆盖语义需保留（用 RENAMENX 或 Lua，不能简单并行）。
- 收益：SSH 场景每次微操作省 100–600ms；本地场景省 1–3ms×次数。

### 4. 批量任务在渲染层逐键循环（IPC + RTT + 同步日志 ×N）
- 位置：`src/store/session.ts` runBulkTask L1170-1214；每键经 `electron/ipc/index.ts` L387 appendLog 同步写盘
- 问题：1000 键删除 = 1000 次 IPC 往返 + 1000 次 Redis 往返 + 1000 次同步写盘；主进程已有批量 deleteKeys（L1692）但面板没用。
- 建议：主进程新增 bulk 通道：DEL 按 500/批分片、TTL 用 EXPIRE pipeline、重命名循环留在主进程；进度按批推送（节流）；保留逐键失败明细与取消令牌（复用 searchTokens 模式）。
- 收益：千键批量从分钟级降到秒级；日志写盘次数降 2–3 个数量级。

### 5. prettyJson 每次渲染同步解析整个 string 值
- 位置：`src/hooks/valueEditor/string.ts` L42（`const parsed = prettyJson(rawValue)` 无 useMemo）；L153 utf8Bytes 同型
- 问题：ValueViewer 任何重渲染（见第 8 项的广播机制）都对 MB 级 JSON 重新 parse+stringify。同文件 statsLines/allRows 都已 memo，此处是漏网。
- 建议：`useMemo(() => prettyJson(rawValue), [rawValue])`；bytes 同理。两行改动。
- 收益：大 JSON 键查看时消除反复的数十 ms 级长任务（项目注释记录过同型 1.6s 长任务教训）。

---

## P1 · 中优先（结构性/场景性收益）

### 6. 操作日志/错误日志/设置全部同步文件 IO
- 位置：`electron/services/log-service.ts` L135（每条 appendFileSync）、L287（每条错误日志后全目录 prune ×2 readdirSync）；`settings-store.ts` L58-99（每次读写全量 JSON）
- 建议：日志改 WriteStream 追加或异步队列（退出时 flush）；错误日志 prune 改每天一次（操作日志已有 lastPruneDay 先例）；settings 进程内缓存 + 防抖落盘。
- 收益：批量/高频操作不再逐次等磁盘；错误风暴时 O(N²) 目录扫描消失。

### 7. Memcached 收包 O(n²) 缓冲拼接
- 位置：`electron/services/engines/memcached/client.ts` L179（每 chunk `Buffer.concat` 全量拷贝）、L260-292（untilEnd 每次从 0 indexOf）
- 问题：`lru_crawler metadump all` 大实例几十 MB 响应 = 二次方拷贝+扫描，主进程阻塞。
- 建议：chunk 数组+长度计数，收齐判定只扫新增尾部与 marker 长度的重叠窗口（或记忆上次扫描偏移）。
- 收益：大实例键枚举从秒级阻塞降到线性时间。

### 8. store 全局版本号广播 → 全组件重渲染
- 位置：`src/store/reactiveStore.ts` L40-43（emit 通知全部 listener，L107 注释自认整体失效）；`subscription.ts` useObservable；20+ 组件整店订阅
- 问题：CLI 输出、搜索进度、Pub/Sub 消息任何一跳都触发键列表+值区+概览卡全部进入渲染流程。React Compiler 已启用但挡不住订阅源变化。
- 建议：短期把高频字段（cliEntries、remoteSearch、消息流）拆独立 store；中期基于已有 proxyPaths 做 useSelector(selector, isEqual) 路径级订阅。
- 收益：高频场景渲染次数下降一个数量级；是渲染层问题的根因项。

### 9. loadAll 逐键 push 触发 N 次 store 通知
- 位置：`src/store/session.ts` L583（循环内 `state.keys.push`）
- 建议：批内收集普通数组，整批一次赋值 `state.keys = [...state.keys, ...batch]`。
- 收益：5000 键全量加载的 proxy 失效/通知开销从 5000 次降到批数次。

### 10. Workspace 每渲染重建 Context API（~40 个 bind）
- 位置：`src/components/Workspace.tsx` L36-37；`src/store/useRedis.ts` buildApi L84-118、pickSessionActions L151
- 问题：Context value 身份每渲染变化，穿透 React Compiler，全部 useContext 消费者重渲染。
- 建议：session 非 null 后按 session 身份缓存 API（注释担心的「会话后建」只影响 null→非 null 一次）；或动作表随会话创建一次性绑定。
- 收益：标签内任何状态更新不再连带全子树 Context 失效。

### 11. 键树形视图无虚拟化 + 排序未复用 Collator
- 位置：`src/components/KeyBrowser.tsx` L1455（treeNodes 全量 map；平铺分支已虚拟化）；`src/utils/keyTree.ts` L79（每次比较 localeCompare 带 options）
- 建议：树按「可见行展平+固定行高」虚拟化（复用平铺 spacer 方案）；模块级 `new Intl.Collator('zh-CN',{numeric:true})` 复用；KeyTreeNode 回调用 useCallback 稳定身份。
- 收益：全部展开数千键时 DOM 从数千行降到视口行数；排序快约一个数量级。

### 12. setValue 整写非原子 + stream 逐条 XADD
- 位置：`connection-manager.ts` L1626-1657（DEL 与整写两条独立命令）、L1671-1677（for await xadd）
- 建议：DEL+写入用 MULTI/pipeline 包裹；stream 行 pipeline 化；大集合 rpush/sadd 按 500/批分片防 argv 过大。
- 收益：消除中间态被其他客户端读到的窗口；N 行 stream 保存从 N RTT 到 1–2 RTT。

### 13. memoryAnalysis 串行 100 批、无进度无取消
- 位置：`connection-manager.ts` L905-934（每 100 键 pipeline await，上限 10k 键）
- 建议：批间 2–4 路并发；复用 searchTokens 取消机制；加进度推送（UI 已有 remote-bar 先例）。
- 收益：SSH 下分析耗时约减半以上，且可中止、有反馈。

### 14. Pub/Sub 与键空间消息逐条 setState
- 位置：`src/components/PubsubCard.tsx` L107、`KeyspaceCard.tsx` L193-197
- 建议：消息进 ref 缓冲，rAF 或 100ms 合帧 flush（VirtualRows scheduleFlush 先例）。
- 收益：高频频道（>100 msg/s）不再逐条驱动渲染。

### 15. settings 保存双轮 Object.assign 广播
- 位置：`src/services/settings.ts` L124-131（patch 一轮 + 主进程回读全量一轮，各 ~18 字段逐次 emit）
- 建议：store 增加 batch() 合并 emit；回读仅写差异字段。树展开防抖、键栏拖拽都走此路径。
- 收益：每次展开/拖拽的渲染通知从 ~36 次降到 1–2 次。

### 16. 渲染层单 chunk 1.53MB，mock 打进生产包
- 位置：`dist/assets/index-*.js` 1,530,053 B（实测）；`src/api/index.ts` L2 静态 import mock（2625 行）；`vite.config.ts` L106-111 无分包
- 建议：mock 改 `!bridge` 时动态 import；ValueViewer/概览/Lua 弹窗 React.lazy；motion/radix 独立 vendor chunk。
- 收益：首帧 V8 解析量下降；生产包剔除整套 mock 数据。

---

## P2 · 低优先（卫生/微优化）

### 17. metrics/serverInfo 每字段全文正则
- 位置：`connection-manager.ts` L702、L745（read() 每字段 new RegExp 扫全文 INFO）
- 建议：INFO 一次 split 建 Map，O(1) 取值。2s 采样 ×17 字段的 CPU 微优化。

### 18. 心跳 Promise.race 超时定时器不清理
- 位置：`connection-manager.ts` L429-432
- 建议：ping 结算后 clearTimeout；防半开死链时 promise 悬挂。量级小（每连接 15s 一个）。

### 19. searchAll 进度每批广播无节流
- 位置：`connection-manager.ts` L1296 → `src/store/global.ts` L164-171
- 建议：主进程 100–200ms 节流合并。百万键库约 200 批全链广播降为 ~10 次。

### 20. deleteKeys/describeKeys 无分片
- 位置：`connection-manager.ts` L1692、L1171-1176
- 建议：500/批分片，防全选数千键时单命令 argv 与回复缓冲过大（与第 4 项合并实施）。

### 21. SlowlogCard 双 1s 定时器
- 位置：`src/components/SlowlogCard.tsx` L509、L516
- 建议：合并为一个 interval；nowMs 仅在自动查询开启时每秒跳动。

### 22. CSS 428KB 双形态选择器 + 仓库遗留物
- 位置：`src/styles/components.css`（428,436 B，`.s-app.xxx, .s-app .xxx` 双形态近乎翻倍）；工作树 nul / xargs.exe.stackdump / _lock-test.asar / .pack-tmp/
- 建议：验证双形态消费场景后裁剪（Vue 迁移遗留）；遗留物归入 .qa/ 或 gitignore。低风险大工程，排最后。

---

## 已做得好的（无需动，避免误改）

- 握手 PING+INFO、监控 INFO+DBSIZE、库列表 CONFIG+INFO 均 pipeline 合并（2 RTT）
- searchAll 循环下沉主进程 + 取消令牌 + 精确搜索 O(1) 短路
- 值区 VirtualRows（实测行高+二分+rAF 合帧+滚动补偿）、平铺键列表固定行高虚拟化
- useTtlClock 共享时钟（零订阅/隐藏停表）；MetricsCard 采样三重门控
- utf8Bytes TextEncoder+ASCII 快路径；listStats/statsLines/lineView/buildKeyTree 已 memo
- 值详情 React Activity 显隐；SSH keepalive 10s×3；probeTimer 清理配对完整
- 启动防白屏（show:false+backgroundColor+ready-to-show）、sandbox、CSP hash、语言包裁剪、blockmap 增量更新

## 方法与证据限制

- 静态审查 + 浏览器 mock 冒烟；未连真实 Redis 做 profiling，所有耗时收益为按 RTT/复杂度推断（项目注释中的 50–150ms/RTT、Blob 77% CPU 等为项目自身历史实测口径）。
- 证据台账 30 行按契约标 unverified（校验器词面绑定要求摘录含产品名，代码行不含），但每行均为程序逐字抽取的源码+行号，可人工复核；校验报告 delivery_mode=framework。
- Memcached manager、ssh-tunnel 仅抽查关键路径；scripts/ 探针与 tests/ 不在审查范围。
- 建议实施顺序：1→2→5（护栏+最小改动）→ 3→4（交互延迟）→ 6→7（主进程 IO）→ 8→9→10（渲染结构）→ 其余。每项独立可回滚，建议逐项配 profile 前后对比。