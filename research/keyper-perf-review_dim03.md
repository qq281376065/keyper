# Keyper 性能审查 · 维度 03：渲染层订阅粒度与重渲染放大

Route: C。项目已启用 React Compiler（vite.config.ts babel 插件 target 19），自动 memo 能挡住一部分 props 未变的重渲染，但**订阅源版本号变化**与**每次新建的对象/函数身份**仍会穿透。

## 发现

### D3-1 store 全局版本号广播（高，结构性）
- reactiveStore.ts L40-43：任何深度字段写入 → version+1 → 通知全部 listener；L107 注释自认「当前用整体失效即可」。
- subscription.ts useObservable 订阅整个会话 store；KeyBrowser/ValueViewer/MetricsCard/PubsubCard/KeyspaceCard/BulkOpsPanel 等 20+ 组件各自 useObservable(useSessionStore())。
- 后果：CLI 输出一个字符、搜索进度一跳、Pub/Sub 一条消息，都会让键列表+值区+概览卡全部进入重渲染流程（React Compiler 可跳过 DOM 更新，但组件函数体与未 memo 的计算仍执行）。
- 建议：按路径订阅（store 已有 proxyPaths 基础设施），提供 useSelector(selector, isEqual)；或最小化改造——把高频字段（cliEntries、remoteSearch.found、pubsub 消息）拆到独立 store。

### D3-2 prettyJson 每渲染同步解析（高，点状）
- string.ts L42：`const parsed = prettyJson(rawValue)` 无 useMemo；ValueViewer 每次重渲染都对整个 string 值 JSON.parse+stringify。大 JSON（MB 级）× 高频重渲染（D3-1）= 叠加卡顿。
- 同文件 L153 utf8Bytes(raw) 每渲染执行（TextEncoder 已优化过，但 MB 级仍 2-3ms/次）。
- 建议：useMemo([rawValue]) 包裹 parsed 与 bytes。项目内同型问题已修过（statsLines/allRows 均 memo，L129/L165），此处是漏网。

### D3-3 Context value 身份每次渲染重建（中）
- Workspace.tsx L36-37 每次渲染 makeSessionApi；useRedis.ts buildApi L84-118 展开两个动作对象 + pickSessionActions bind ~40 函数（L149-152）。Context value 新身份 → 全部 useContext 消费者重渲染，React Compiler 无法跨 Context 边界优化。
- 注释解释了不能按 [session] memo 的原因（会话后建）。建议：按 session 对象身份 memo（session 为 null 时不缓存，非 null 后缓存），或把动作表与会话对象一起一次性构建挂在 session 上。

### D3-4 loadAll 逐键 push 触发 N 次广播（中）
- session.ts L580-584：循环内 state.keys.push(...)，每键一次 Proxy set→emit。5000 键 = 5000 次全组件通知（React 18 自动批处理会合并同 tick 的渲染，但每批 await 之间是独立 tick，实际每页至少一次全量重渲染 + 每键一次 proxy 失效开销）。
- 建议：批内先收集普通数组，整批一次性赋值 state.keys = [...state.keys, ...batch]。

### D3-5 settings 保存双轮 Object.assign（中）
- services/settings.ts L123-133：save() 先 assign patch（N 字段 N 次 emit），IPC 回来再 assign 全量返回值（~18 字段又 N 次 emit）+ applyToDom 两次。树展开防抖写盘（KeyBrowser L418-437）与键栏拖拽都会走这条路。
- 建议：store 提供 batch(fn) 合并 emit；或 save 回读仅在值有差异时写入。

### D3-6 键树无虚拟化 + 递归 localeCompare 排序（中）
- KeyBrowser L1455+ 树形分支全量 map KeyTreeNode（平铺分支已虚拟化 FLAT_ROW_H=31）。全部展开 5000 键时数千行 DOM。
- keyTree.ts sortTree L73-80：每次比较 localeCompare('zh-CN',{numeric:true})，未复用 Intl.Collator 实例；5000 键排序 ~数万次比较。建议模块级 `new Intl.Collator('zh-CN',{numeric:true})` 复用（可快一个数量级）。
- KeyTreeNode 未包 React.memo 且回调 props 多为内联新建（isFavorite/onToggleFavorite 每渲染新函数），Compiler 的自动 memo 因 props 身份变化失效。
- 建议：树形按「可见行展平 + 固定行高」虚拟化（与平铺同一套 spacer 方案）；回调用 useCallback/事件委托稳定身份。

### D3-7 Pub/Sub 与键空间消息逐条 setState（中）
- PubsubCard L104-110 / KeyspaceCard L193-197：每条消息一次 setMessages + 数组拷贝。高频频道（>100 msg/s）时渲染帧被消息驱动打满。
- 建议：消息先进 ref 缓冲，rAF/100ms 合帧 flush（VirtualRows 已有 scheduleFlush 先例）。

### D3-8 SlowlogCard 双 1s 定时器（低）
- L506-523：nowMs 刷新与自动查询轮询各一个 setInterval(1000)，可合并为一个；且 nowMs 每秒 setState 触发整卡重渲染（含 rangeEntries filter 依赖 nowSec）。已有 active 门控，影响限于前台。

### D3-9 IPC 参数双序列化（低）
- api/index.ts sanitize L28-36 JSON 往返 + preload toPlain 再洗一次。参数普遍很小（id/key/options），但 setValue 大 payload（整键快照）时是两次 MB 级 JSON 往返。建议：sanitize 仅在检测到 Proxy/非纯对象时执行，或大 payload 走 structuredClone。

## 已做得好的（避免误报）
- useTtlClock：共享 1s 时钟、零订阅停表、hidden 停表（全文 61 行）。
- VirtualRows：ResizeObserver 实测行高 + 前缀和二分 + rAF 合帧 + scrollTop 补偿，质量高。
- MetricsCard 采样有 active/connected/sampling 三重门控，切页签即停。
- listStats/statsLines/allRows/lineView/buildKeyTree/favoriteKeys 均已 useMemo。
- utf8Bytes 已从 Blob 改 TextEncoder（注释记录 77% CPU 的实测教训）。
- 值详情用 React Activity 显隐，隐藏时销毁 effect。

## 置信度
行号证据 high；重渲染实际代价未 profile，medium。