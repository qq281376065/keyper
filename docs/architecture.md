# Keyper 架构地图

> 面向后续开发与 AI 会话的代码索引。整理于 2026-11-04。
> **分工**：本文讲「代码在哪、怎么串起来」；`docs/development-pitfalls.md` 讲「哪些坑不能踩」，
> 两篇配合使用。本文不写版本号、命令清单、完整目录树（会漂移），用时以
> `package.json`、`shared/api.ts` 与实际目录为准。
>
> 项目定位：Electron 33 + React 19 + TypeScript 的 Redis / Memcached 双引擎桌面客户端，
> 由 Vue 3 版 RedisDesktop **移植式重写**而来 —— 这解释了状态层、样式作用域、
> 组件命名的诸多「不像原生 React」之处，改动前先理解这层历史。

## 1. 一页看懂分层

| 层 | 目录 | 职责 | 关键约束 |
| --- | --- | --- | --- |
| 共享契约 | `shared/` | 主进程 / preload / 渲染层共用的**唯一**类型源 | 任何跨进程改动从 `api.ts`、`types.ts` 起步 |
| 主进程 | `electron/` | 窗口、IPC、Redis/Memcached 客户端、SSH、加密、文件存储、自动更新 | 不 import 渲染层；配置默认落程序目录 `config/` |
| 桥接 | `electron/preload.ts` | `contextBridge.exposeInMainWorld('redisApi', …)` | 参数清洗在**渲染层**才是主防线，preload 是第二层兜底 |
| API 适配 | `src/api/` | 有 bridge 走 IPC，没有降级 `mock.ts`（浏览器预览） | 双实现必须同批补，否则 `dev:web` 直接报错 |
| 状态 | `src/store/`、`src/hooks/` | Proxy + 版本号 + `useSyncExternalStore` 复刻 Vue `reactive` | 全局字段走 `GLOBAL_KEYS` 优先，会话字段按 connId 隔离 |
| 视图 | `src/components/`（70+ tsx）、`src/App.tsx` | 应用外壳、连接侧栏、键浏览、值区、概览监控、弹窗、CLI | 双引擎两套平行组件，由 `Workspace.tsx` 分派 |
| 样式 | `src/styles/` | 全局 CSS + 9 套主题 + Tailwind 4（仅 `components/ui/`） | `.s-<组件>` 作用域类由脚本注入 |
| 文案 | `lang/` + `shared/i18n/` | `en.ts` 为唯一来源，`MsgKey` 由其推导 | 三份字典同批；`i18n:check` 会判「未引用键」失败 |
| 工程 | `scripts/`、`tests/unit/`、`.github/workflows/` | 构建校验、单测、CI / Release / Pages | 只有 3 个脚本被 npm/CI 引用，其余是临时探针 |

**启动链路**（`electron/main.ts`）：诊断 trace 与全局异常落盘 → 判定 `VITE_DEV_SERVER_URL` →
`requestSingleInstanceLock()`（未获锁退出，`second-instance` 聚焦已有窗口）→ `whenReady()`：
设置系统语言 → 移除应用菜单 → `applySessionHardening()`（CSP 响应头 + 权限默认全拒）
→ `registerIpcHandlers()` → 清理旧日志 → `createMainWindow()`。

窗口 `show:false` 等 `ready-to-show`，`contextIsolation:true` / `nodeIntegration:false` / `sandbox:true`；
开发 `loadURL(DEV_SERVER_URL)` 并自动 detach DevTools，生产 `loadFile(dist/index.html)` 走 `file://`。
**关闭链路是自绘确认框**：`close` 一律 `preventDefault`，推 `app:beforeClose` 给渲染层，
5 秒兜底强制 destroy；用户确认后经 `closeSignal` → `disconnectAll()` → destroy。

## 2. 进程间契约：新增能力必走的 5 处

`shared/api.ts` 里 `RedisDesktopApi` 定义完整接口，`IPC` 是 `as const` 通道表（百余条，
M5/M6 后仍在增长，以文件为准），命名一律 `namespace:action`；主→渲染推送用
`xxxChanged` / `xxxEvent` / `xxxMessage` / `xxxProgress` / `app:beforeClose`。

新增一条 IPC 的固定清单（漏一处就静默坏）：

1. `shared/api.ts`：`RedisDesktopApi` 加方法签名 + `IPC` 加常量。
2. `electron/preload.ts`：`invoke` 包装；推送型还要写 `ipcRenderer.on` + 退订函数。
3. `electron/ipc/index.ts`：`handle()` 注册；推送型用 `BrowserWindow.getAllWindows()` 广播。
   需要操作日志就进 `LOG_ACTIONS` 白名单，并在 `describe()` 补参数下标（下标硬编码，
   参数顺序一变日志详情会静默错位）。
4. `src/api/mock.ts`：补同签名实现（浏览器预览靠它）。
5. `lang/*` + `src/components/*`：文案与 UI 同批落地。

`handle()` 统一 try/catch、包 `{ok, data|error}`、`unwrap()` 把业务 `ok:false` 转异常。
窗口控制与主→渲染推送**刻意不走**通用 `handle`。

## 3. 状态模型与会话隔离

- `src/store/reactiveStore.ts`：`createStore` 返回 Proxy，`get` 对纯对象/数组递归 `wrap`
  并用 WeakMap 缓存，`set`/`delete` 沿脏路径清缓存并递增 `version`；
  `subscription.ts` 用 `useSyncExternalStore` 接入 React。**只认纯对象/数组**：
  新增 `Map/Set/Date` 字段不触发重渲染，且过 IPC 前要转普通结构。
- `useRedis.ts` 的 `GLOBAL_KEYS` 是读写优先级核心：会话 state 为满足 `AppState` 形状
  也带一份同名空默认值，所以 `makeStateProxy` / `followState` **必须先判全局字段**，
  否则标签外组件读 `state.connections` 会拿到空数组。
- 会话隔离：`global.ts` 用 `sessions = Map<connId, RedisSessionApi>()` 与 `tabs` 同步，
  `snapshots` 存关标签时的 `activeDb / pattern / selectedKey`；`Workspace.tsx` 渲染期取会话
  并用 `RedisSessionContext.Provider` 注入，子树 `useRedis()` 直绑本会话。
  `App.tsx` 把所有标签**常驻挂载**，非激活用内联 `display:none`（不是裸 `hidden`），
  切标签保留树展开、滚动、草稿；只有 `closeTab` 才 dispose 并存快照。
- 两层保活要分清：**标签层**靠 hidden + `BlurTickContext`（`useTabBlur` 关闭挂到 body 的
  portal 浮层）；**值区书签层**用 React `<Activity>`（`ValueViewer.tsx` 每个键一个
  `ValueDetailPane`）。Activity 隐藏→重显会重放 effect，新 effect 必须幂等，
  已有 `valueEditor/string.ts`、`hash.ts` 用 ref 记住签名防丢草稿。
- 按 `connId@db` 分桶的还有搜索历史、`settings.expandedPaths`。
  `sessionActions` 是「调用时刻解析 currentSession()」的转发器，异步 `await` 后再调
  会打到切换后的标签 —— 标签树内一律用 Context 直绑。

**新增状态字段要同步 5–7 处**：`RedisState` → `AppState` → `createSession` 初值 →
`EMPTY_STATE` → （全局字段才需要）`GLOBAL_KEYS` + `GlobalState` + `globals`。

## 4. 双引擎分派

`shared/types.ts` 的 `CacheEngine = 'redis' | 'memcached'` 是判别联合；
配置分 `BaseConnectionConfig` + 两个引擎子类型，运行时状态同构分叉。
老配置由 `connection-store` 补 `'redis'`，新连接漏带 `engine` 会让 `registry` 判为字段缺失。

| 层 | Redis | Memcached |
| --- | --- | --- |
| 主进程 | `services/connection-manager.ts`：每 connId 一个 ioredis 实例，另挂独立 Pub/Sub、keyspace 连接与心跳 | `services/engines/memcached/{manager,client,pool}`：每 connId 一个 4 连接轮询池 |
| 分派 | `services/engines/registry.ts` 的 `Map<CacheEngine, handlers>` 分 connect/test/disconnect | 同左；断开靠 `memcachedManager.owns(id)` 判持有者 |
| IPC | `redis:*`（值/键/流/CLI/监控/Pub-Sub，约 50 条） | `memcached:*`（约 10 条） |
| 视图 | `KeyBrowser` / `ValueViewer` / `ServerOverview` + 6 类值视图 | `MemcachedKeyBrowser` / `MemcachedValueViewer` / `MemcachedOverview`，仅 bytes 一类 |
| 选路 | `Workspace.tsx` 按 `connections.find(...).engine` 选左右两栏组件 | 同左 |

命名空间彻底分开、无共用通道；仅 `tunnelManager`（SSH 跳板）共用但按 id 隔离。
落盘同一份 `connections.json`，靠 `engine` 字段区分。
⚠️ `IPC.connectionStatus` 只查 `connectionManager.isConnected()`，Memcached 恒 false ——
判断归属必须用 `memcachedManager.owns(id)`。

**产品口径**：Memcached 是「逐步补齐到 Redis 同等能力」，只能移植/补齐，
不得以「统一」为由删字段、入口或功能；破坏性操作统一走 `askConfirm` 结构。

## 5. 视图层地图

`App.tsx` 的 `.shell.s-app`：顶栏（品牌 + 日志/设置/语言/主题/自绘窗口控制）
→ `main.body`（`ConnectionSidebar` + `.workspace` 内 `TabBar` + `.workspace-body`）
→ 底部 `CliConsole` → 全局弹窗挂载点与 `AppTooltip`。bootstrap 顺序固定：
设置读盘 → 主题迁移 → `applyTheme` → `api.bootstrap()`。

| 组 | 代表组件 | 备注 |
| --- | --- | --- |
| 外壳 | `App`、`Workspace`、`SplitPane`、`TabBar` | 多标签常驻、内联 display 隐藏 |
| 连接 | `ConnectionSidebar`、`ConnectionDialog`、`EngineGlyph`、`Import/Export*` | 名称行前置引擎图形（方案 05） |
| 键浏览 | `KeyBrowser`(~1746 行)、`MemcachedKeyBrowser`、`KeyTreeNode`、`FavoritesPanel` | 树形 \| 平铺 \| 收藏三段；幽灵补全；计数在筛选框右侧纯文字 |
| 值区 | `ValueViewer`(~2886 行)、`MemcachedValueViewer`(~1367 行) | 见下 |
| 概览监控 | `ServerOverview`、`MemcachedOverview`、`MetricsCard`、`KeyspaceCard`、`MemoryCard`、`PubsubCard`、`SlowlogCard` | 二级页签带语义图标 |
| 弹窗 | `DialogShell` → `PromptDialog` / `ConfirmDialog` / `Edit*Dialog` | Radix Dialog + 拖拽 + 固定页脚；`requirePhrase` 硬门槛 |
| 通用 | `tip.ts`+`AppTooltip`、`DialogIcon`(~851 行)、`ErrorBoundary`、`components/ui/*` | 约 70 个内联 SVG 图标 |
| CLI | `CliConsole`、`StreamAdminPanel`、`LuaScriptDialog`(M6) | 命令目录 370 条、补全、历史按连接持久化 |

**Redis 值区**：外壳管书签缓存与连接切换 → 每个书签一个 `<Activity>` 的 `ValueDetailPane`
→ masthead（类型眉标 + 键名 + 右上 ⋮ + TTL/encoding/大小）→ 分段工具条
（string 六项：编辑/复制/JSON 美化/自动换行/导出/刷新；其余类型 4 动作 + 自动刷新）
→ 六类视图（string 虚拟行、hash 可拖列宽 + 7.4 字段 TTL、list/set/zset/stream；
stream 另含 messages/groups/pending 三页签与 `StreamAdminPanel`）
→ 底部书签栏（方案 05：固定详情 + 箭头 + 标签 + ⋯ 更多面板）
→ 五套行右键菜单 + 十余个编辑弹窗。

**Memcached 值区**：`renderSection` 单块渲染，无 Activity 保活、无六类视图、无行菜单；
masthead 显示 TTL/size/flags，书签与统计卡与 Redis 同构。

**通用机制**：`tip.ts` 用 `defineStore` 造全局单例，`showTip` 带 `seq` 自增绕过
`Object.is` 判等；`AppTooltip` 必须 `useObservable` 订阅，用 `createPortal` 挂 body
规避裁剪；`WeakMap` 处理嵌套绑定（子元素移回父元素时还原父级提示）。
**任何读单例 store 的组件都必须订阅**，这是移植期最容易复发的一类缺陷。

## 6. 样式与主题

`src/main.tsx` 加载顺序：`main.css` → `components.css` → `tailwind.css`。

- `main.css`（1404 行）：设计令牌、9 套主题（dark 默认 + light/ocean/solarized/forest/
  sakura/mint/mist/aurora）、全局元素、按钮胶囊 `999px !important` 白名单、
  `--lift-shadow` / `--lift-a1/a2`。**新增按钮类名必须登记进白名单**，
  页签 / 抽屉把手 / 表单控件是显式豁免。
- `components.css`（约 12600 行）：36 个组件作用域段，选择器形态
  `.s-x.sel, .s-x .sel`（自身命中 + 后代命中）。由 `scripts/rescope-css.mjs` 按
  `/* Xxx.vue */` 段注释生成，`scripts/inject-scope.mjs` 给组件根 JSX 注入同名类。
  **新增组件三件套**：根元素 `s-<kebab>` 类 + CSS 段注释 + 双命中选择器；
  portal 到 body 的浮层要手工补作用域类。
- `connection-dialog.css`：`dlg-*` 弹窗骨架；`tailwind.css`：Tailwind 4 入口，
  声明 `@layer theme, base, components, utilities`、**关闭 Preflight**、dark 变体接 `[data-theme]`；
  `main.css` 把 `button/input` 默认值包进 `@layer base`，否则会压过 utilities。
- `tailwind-cards.css`：主页 Cult UI 卡片，`--card-face-bg` 覆盖规则必须在 `@layer` 之外
  （unlayered 优先于任何 layer）。`geist-pixel.css`：像素字体 @font-face。

## 7. 构建、测试、发版

- `vite.config.ts`：`mode=web` 时**不挂载 electron 插件**（只起 Vite、数据走 mock）；
  非 web 用 `vite-plugin-electron` 独立编译 main/preload 到 `dist-electron`、强制 CJS、
  external 掉原生依赖；主进程不继承顶层 alias，需单独配 `@shared`。
  React Compiler 经 `@vitejs/plugin-react` 的 babel 钩子接入（`target:'19'`）。
  `base:'./'`、`__APP_VERSION__` 构建期注入。
- **CSP 双通道**：源码 `index.html` 只有内联主题脚本、无 CSP；生产由
  `main.ts` 的 `onHeadersReceived` 注入响应头，但 `file://` 不触发，
  故 `scripts/csp-hash.mjs` 在 build 后算内联脚本 sha256 写 meta CSP。
  内联脚本改一个字节都要重算；新增外链/Worker 要同步改 `csp-hash.mjs` 与 `main.ts` 两处指令表。
- 双 tsconfig：`tsconfig.node.json` 收 electron/shared/vite 配置与 4 个 electron 侧 spec；
  `tsconfig.web.json` 收 src/shared 与其余 spec 并 exclude 那 4 个。
  涉及 electron 的新 spec 要两边同步调整；DOM/hook 测试要在 `vitest.config.ts` 加 jsdom glob。
- 测试：`tests/unit/` 约 20 个 spec，覆盖 keyTree/keyspace/format/valueFormats/i18n/
  connectionUri/connectionTransfer/cliSuggest/redisCapability/credentialCrypto/
  engineIsolation/memcachedClient/memcachedManager（含假服务端 fixture）。**无 e2e 框架**。
  `scripts/` 下仅 `csp-hash.mjs`、`i18n-check.mjs`、`site-check.mjs` 被 npm/CI 引用，
  其余 40+ 个 `probe-/repro-/measure-/shot-/verify-*` 是临时探针。
- 工作流：`ci.yml`（push/PR → i18n:check、typecheck、test、vite build、CSP 校验，不打包）；
  `release.yml`（tag `v*` 或手动；校验 tag 与 package.json 版本一致、从附注标签生成
  **两处** release-notes、Prepare 阶段取消草稿并合并重复 Release、`dist:win:publish`、
  下载直链复核）；`site.yml`（main 且 `site/**` 变更 → Pages）。
- `electron-builder.yml`：win 仅 NSIS x64（**无 portable**，「便携」只指配置随程序目录走）、
  asar、publish=github、`releaseType: release`、**无代码签名**。
  `build/installer.nsh` 是唯一入口并 include 8 个 nsh；NSIS 脚本编译两趟，
  符号需用 `BUILD_UNINSTALLER` 隔离，任何 warning 都会被当错误。

## 8. 当前进度（2026-11-04）

- 已提交里程碑：**M0**（契约/限值/Stream 能力位）、**M1**（TTL 倒计时）、
  **M2+M3**（收藏、值格式解码）、**M4**（CLI 补全/历史/输出）、
  **M5**（Stream 消费组、PEL、XTRIM/XDEL，`f8a88b4`）、
  **M6**（Lua 运行器、片段管理与批量删除，`75ccd3c`）。
- 下一步：**M7 全量回归（M5/M6）、全量测试、打包自检、发布说明**；逐项清单以 Qoder 记忆
  `E--MyProject/memory/redisdocker-feature-expansion-m0.md` 为准。
  其中「全量测试」仍受交付闸门约束，必须用户当轮明确点名。
  发版相关不可逆约束见 `docs/development-pitfalls.md` 第 6 节。
- 工作区状态随其它会话实时变化，**以 `git status --short` 为准**；本节只记录已提交的里程碑，
  不维护未提交文件清单（避免描述反复滞后）。
- README 中英双版已在 **v1.1.0**（`6e6dafb`）同步：21 个 spec / 208 个用例、
  `csp:check`、`preview:tooltip` 均已列入；此前记录的「命令清单与 spec 数漂移」已修复。

## 9. 需求 → 改动位置速查

| 需求 | 必改文件 |
| --- | --- |
| 新增文案 | `lang/en.ts` 加语义 key → `zh-CN.ts` / `zh-TW.ts` 同批 → 组件 `t()`；跑 `i18n:check` |
| 新增 IPC / 引擎能力 | `shared/api.ts` → `preload.ts` → `electron/ipc/index.ts` → `src/api/mock.ts` → UI；推送型另加广播与退订 |
| 新增状态字段 | `session.ts` 的 `RedisState`/`AppState`/初值 → `useRedis.ts` 的 `EMPTY_STATE` → （全局）`GLOBAL_KEYS` + `GlobalState` + `globals` |
| 新增组件 | 组件根加 `s-<kebab>` 类 → `components.css` 带段注释 + 双命中选择器 → 按钮类名登记 `main.css` 白名单 |
| 新增 tooltip | 一律 `tipProps`，禁原生 `title`；`DialogShell` / `PromptDialog` 的 `title` 是组件 prop，不要误改 |
| 新增主题 | `main.css` 主题块 + `index.html` 的 SCHEME 首帧脚本 |
| 新增测试 | `tests/unit/*.spec.ts`；electron 侧 spec 同步两处 tsconfig，DOM 测试加 vitest jsdom glob |
| 改主页卡片 | `tailwind-cards.css`（注意 `@layer` 之外才生效）+ `components/ui/expandable.tsx` |
| 发版 | `docs/development-pitfalls.md` 第 6 节；标签推上去后不可再动 |

## 附：关键文件速查

| 路径 | 作用 |
| --- | --- |
| `shared/api.ts` | 全量 API 契约 + IPC 通道表（约 748 行，持续增长） |
| `shared/types.ts` | 连接/引擎/值/设置/结果类型 |
| `shared/limits.ts` | 收藏、CLI 历史、Lua、二进制、PEL 页、结果大小等共享上限 |
| `electron/main.ts` | 窗口、安全策略、关闭链路、CSP 响应头 |
| `electron/ipc/index.ts` | 全部 handler 注册、`LOG_ACTIONS`、`describe()` |
| `electron/services/engines/registry.ts` | 双引擎分派表 |
| `src/store/reactiveStore.ts` / `useRedis.ts` | Proxy 状态核心、全局/会话优先级 |
| `src/components/Workspace.tsx` | 每连接会话注入 + 引擎选路 + 标签失焦广播 |
| `src/components/ValueViewer.tsx` | 值区全貌（约 2886 行，最大组件） |
| `scripts/inject-scope.mjs` / `rescope-css.mjs` | 样式作用域生成 |
| `docs/development-pitfalls.md` | 坑位速查（授权、工具链、移植陷阱、产品定案、发版） |
