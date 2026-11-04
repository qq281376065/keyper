# Keyper 优化与升级方向清单

> **基准**：2026-11-04 当前代码（`6e6dafb chore(release): v1.1.0`），所有指标来自代码实测
> 或官方发布页查询，不是泛指的最佳实践。外部版本信息查询于 2026-11-04。
>
> **性质**：方向建议，**不是已批准的需求**。任何一条动工前先按
> `docs/conventions.md` 基线（第 1/2/10 节）执行，大改走「方案（D1…Dn）→ 接口契约 →
> 实现 → 验证 → 等指令提交」；UI 开放题先出多方案预览。全量测试、升版本、打包、提交/推送
> 各自需要当轮明确指令。
>
> **优先级**：P0 = 安全 / 正确性风险；P1 = 工程质量与可维护性；P2 = 体验与功能；
> P3 = 长期演进。每条给出「现状证据 → 建议 → 收益 / 代价 → 主要风险」。

---

## 0. 结论先行：最该先做的三件

1. **升级 Electron 33**（P0）：已 EOL 约 18 个月，缺 Chromium / Node 安全补丁。
2. **把两条样式校验脚本接进 CI**（P1）：`check-lift-shadow.mjs` / `check-tab-lift.mjs`
   实测 `npm=0 / CI=0` 引用，规范会随时间退化。
3. **补最小 e2e 冒烟**（P1）：当前 21 个 spec / 208 用例全是纯函数与 hook，`tests/` 下
   **没有任何 e2e 目录或 Playwright 配置**，UI 回归完全靠人工。

---

## 1. P0 — 安全与运行时正确性

### 1.1 Electron 33.2.1 → 受支持版本
- **证据**：`package.json` → `electron: ^33.2.1`；官方发布计划显示 Electron 33 稳定于
  2024-10-14、**EOL 2025-04-28**；当前稳定线为 45.x（Chromium 156 / Node 24），
  官方只支持最近三个大版本。
- **影响**：约 18 个月无安全补丁；且跨 12 个大版本，`contextBridge` / `safeStorage` /
  CSP / `webPreferences` 行为都可能变化。
- **建议 / 已定案**：用户 2026-11-04 拍板**不走阶梯，一步到位 45.2.2**；固定验证清单一次性跑完：
  ① 旧 `enc2:` 密文仍能解密并真实连上服务器；② preload 的 JSON 参数清洗；
  ③ `CSP_PROD` 响应头与 `dist/index.html` 的 meta 双通道；④ NSIS 打包与安装启动；
  ⑤ 自动更新（atom + `latest.yml`）；⑥ `--rd-debug` 与 DevTools。
- **收益 / 代价**：安全合规 + 新 Chromium 能力；代价是 electron-builder /
  `vite-plugin-electron` / `@types/node` 需同步，且需出包做一次完整真机验证（阶梯方案已否决）。
- **风险**：**高**。必须独立 feature 分支、整体可回滚；出问题时无法二分定位（阶梯已否决）；标签推上去后绝不能再动。

### 1.2 Windows 代码签名与 360 误报（未决项）
- 证据：`electron-builder.yml` 无签名配置；记忆 `project-windows-signing-360` 记录
  `ffmpeg.dll` 等未签名致 360 拦截。
- 建议：OV/EV 证书 + 360 开放平台报备；打包侧排除未使用的 `ssh2/util/pagent.exe`。
- 风险：证书采购与信誉积累是外部依赖，**不要**建议关闭/绕过安全软件。

### 1.3 CSP 双通道改为单一来源
- 证据：`electron/main.ts` 的 `CSP_PROD` 指令表与 `scripts/csp-hash.mjs:34-45`
  **两处手工硬编码**，改一处漏一处即首屏主题脚本被拦（亮暗闪烁）。
- 建议：抽一份共享指令常量（放 `shared/` 或构建脚本单一模块），两处引用同一份；
  `csp:check` 增加「响应头指令 == meta 指令」断言。
- 代价：低；风险：低（但属于构建链，改完必须 `vite build` + `csp:check` + 打包版验证）。
- **2026-11-04 已处理的部分**：确认 Electron 45 起 `file://` 主文档也会触发
  `onHeadersReceived`，故 `applyContentSecurityPolicy()` 已对 `file:` 短路，生产版
  实际只由 meta CSP 约束（详见 `docs/csp-fix-plan.md`）。本条「两处硬编码」债务仍在，
  但响应头指令表对生产 `file://` 已不再生效，优先级从「首屏闪烁风险」降为
  「一致性与开发态维护」；抽单一来源时 `csp:check` 应补「响应头指令 == meta 指令」断言。
  D4 明确本次不抽，避免在修升级回归时叠加重构。

### 1.4 凭据边界收口
- 证据：`connection-store` 仅加密 `password` 与 `ssh.password/passphrase` 白名单，
  `ssh.privateKey` 明文落盘；`saveConnections` 的「undefined 保留磁盘旧密文」语义
  要求新增通道必须原位改磁盘条目。
- 建议：把「哪些字段要加密」做成显式常量 + 一条单测；新增凭据字段时由 `i18n`-like
  校验脚本兜底，避免 `...item` 展开漏加密或双重加密。
- 风险：涉及已落盘数据，改动必须兼容旧格式并保留迁移测试。

### 1.5 自动更新的下载校验常态化
- 证据：`release.yml` 已针对草稿 / 重复 Release 做 Prepare + 下载复核；
  electron-updater 走 `releases.atom` → `releases/download/<tag>/latest.yml`。
- 建议：把「未认证请求能否取到 3 个资产」做成发版后固定检查项，避免再次出现
  「流水线全绿但用户下不到」。

---

## 2. P0 / P1 — 现有代码的结构性债务

| # | 现状证据 | 建议动作 | 收益 / 代价 | 主要风险 |
| --- | --- | --- | --- | --- |
| 2.1 | `ValueViewer.tsx` 2886 行、`KeyBrowser.tsx` 1746 行、`components.css` 13391 行、66 个业务 tsx | 按值类型把六类视图拆成独立 Pane（已有 `hooks/valueEditor/*` 可顺势复用）；先出拆分方案与回归清单 | 可维护性显著提升；代价是改动面大 | 破坏 `<Activity>` 保活、`.s-*` 作用域与右键菜单；**必须**方案确认后动 |
| 2.2 | M5/M6 新增 CSS 段（`.stream-tabs` / `.sa-*` / M6 +926 行）是**无 `.s-*` 前缀的全局选择器** | 补双命中作用域或手工加前缀；产物级检查加一条「新段无前缀」告警 | 避免重演 `.type-badge` 同名覆盖事故 | 低，但需逐段核对视觉 |
| 2.3 | `shared/api.ts` 现有 **129 条** IPC 通道，新增一条要手工联动 5 处 | **不建议**上代码生成（与「显式优于小 DSL」偏好冲突）；改为加一条「契约一致性校验脚本」：检查签名 / 常量 / preload / handler / mock 五处是否成对 | 消除漏 mock、漏 handler 的静默故障 | 低；脚本要进 CI 才有效 |
| 2.4 | `wrapApi` 限深 3 层；`sessionActions` 异步 `await` 后可能打到切换后的标签；`IPC.connectionStatus` 只查 Redis（Memcached 恒 false） | 补三条针对性单测 + 统一用 `memcachedManager.owns(id)` 判归属 | 消除跨连接状态污染 | 低 |
| 2.5 | `ui/dialog.tsx` / `ui/select.tsx` 仍在用 `animate-in` / `zoom-in-95` 等**全库无定义**的死类 | 装 `tw-animate-css` 激活，或直接删掉这些类 | 弹窗/下拉终于有入场动画 | 低；注意不引 Preflight |
| 2.6 | `--color-destructive` 映射到 `var(--accent)` | 改为独立危险色令牌，9 套皮肤各配一份 | 危险态不再与强调色同色 | 低，需全主题目视核对 |
| 2.7 | Slot 双版本：`button.tsx` 用 `radix-ui` 的 `Slot.Root`，`bg-animate-button.tsx` 用 `@radix-ui/react-slot` | 统一到一处依赖 | 减少双事件/双 ref 隐患 | 中，涉及 Cult UI 组件 |
| 2.8 | 9 套皮肤，Tailwind `@custom-variant dark` 只认 dark / ocean / forest | 补齐或显式声明「浅色皮肤不走 dark:」并在文档写清 | 避免新组件在 6 套浅色下落到 `bg-white` | 低 |

---

## 3. P1 — 测试与工程化

| # | 现状 | 建议 | 优先级理由 |
| --- | --- | --- | --- |
| 3.1 | `tests/` 只有 `unit/` + `fixtures/`，**无 e2e、无 Playwright 配置** | 补 6 条 CDP/DOM 冒烟：启动、mock 连接、六类值渲染、切标签状态隔离、删除二次确认、主题切换；**不截图**，用 DOM / 计算样式断言 | UI 回归目前零自动化 |
| 3.2 | `check-lift-shadow.mjs` / `check-tab-lift.mjs` 实测 npm / CI 引用均为 0 | 加 `npm run check:styles` 并接进 `ci.yml`，把 hover 阴影规范变成门禁 | 规范清单已定为基线，却无自动守护 |
| 3.3 | `ci.yml` 用 `npx vite build` + 手动 `csp-hash` / `csp:check`（有注释说明） | 保持现状或抽成 `npm run build:ci`；**不要**改成 `npm run build` 就删掉哈希步骤 | 只挂 build 链的后处理不会被 CI 执行 |
| 3.4 | `.gitignore` 忽略整个 `scripts/`，新增要 `git add -f` | 把「需入库的校验脚本」集中到白名单或在 CI 里显式列出 | 新校验脚本容易写了却没进版本库 |
| 3.5 | 双 tsconfig 靠手工 exclude/include electron 侧 spec；jsdom 只对 `searchHistory.spec.ts` 开 | 新 spec 归属做成脚本检查或模板 | 新增测试易踩 `document is not defined` |
| 3.6 | 发版前检查项分散（tag ↔ package 版本、两处 release-notes、package-lock 版本、NSIS warning、下载直链） | 做一个 `scripts/pre-release-check.mjs` 汇总只读检查，不自动发版 | 减少不可逆事故 |
| 3.7 | v1.1.0 已同步 README（21 spec / 208 用例 / `csp:check` / `preview:tooltip`） | 把「README 里的脚本清单 / spec 数」做成 CI 只读比对 | 历史上漂移过两次 |

---

## 4. P1 / P2 — 性能与资源

| # | 现状 | 建议 | 约束 |
| --- | --- | --- | --- |
| 4.1 | 所有连接标签常驻挂载（内联 `display:none`），值区每个键一个 `<Activity>` 常驻 | 评估标签 / 书签上限或 LRU 淘汰，量测内存与隐藏 DOM 数 | 「切回零重建、草稿不丢」是产品硬定案，**必须先出方案确认**，不能直接改 |
| 4.2 | `PixelHeading` 用 `TICK_MS=50` 的 `setInterval` 逐字直写 `className` | 空闲 / 页面隐藏时停表，或改成 CSS 动画 | 已有 `prefers-reduced-motion` 处理，别破坏 |
| 4.3 | `LiveTtl` 单例 1s 时钟已做；大列表订阅面未量测 | 用 React Profiler 量一次键树 / 值区切换的重渲染范围 | React Compiler 已定案，**不要**到处手写 memo |
| 4.4 | 二进制值原始 4MB / 解压 5MB 上限，已有 `VirtualStringLines` | 评估分片加载 / 大值只读预览 | 解码视图禁编辑是定案 |
| 4.5 | Redis 每连接一个 ioredis + 独立 Pub/Sub + keyspace 连接 + 15s 心跳；Memcached 4 连接池 | 多连接场景做资源量测，补「断开必须成对清理」的守护测试 | 新增订阅要自开独立连接 |

---

## 5. P2 — 功能 / 需求方向（按投入产出排序）

1. **Redis 兼容族型号识别**（已有定案、未实施）：`INFO` 解析 `valkey_version` /
   `dragonfly_version` 等，辅以 `COMMAND DOCS` 能力探测与降级；P0 约 1 天、P1 约 2–3 天。
   **不新增 `CacheEngine` 类型**。
2. **Stream 深化剩余**：M5 已做消费组 / 消费者 / PEL / XTRIM / XDEL；可补消费延迟趋势、
   XREADGROUP 实时流视图、消费组批量操作。
3. **Lua 运行器后续**：M6 已做片段持久化 / 批量删除 / 只读 EVAL_RO；可补语法高亮、
   结果表格化、脚本版本历史、常用脚本模板。
4. **CLI**：370 条命令目录已生成；可补命令文档悬浮、执行耗时、结果导出模板。
5. **值格式**：MessagePack / PHP serialize 是手写有限子集（本机 npm 受限），
   补边界用例与明确的能力说明，或评估替换成熟解码库。
6. **监控**：keyspace / 内存 / 慢查询 / Pub-Sub 已有卡片；可补趋势图、阈值提示、导出。
7. **皮肤与组件**：9 套皮肤齐全；Cult UI 官方 154 个组件可按需引入
   （见 `docs/cultui-components.md`），但先过**依赖闸门**（`@base-ui/react` 未装）与
   Keyper 规范对齐（胶囊 / `--lift-shadow` / `tipProps` / 三语言）。
8. **官网与下载页**（`site/` 已上线）：版本归档、更新日志、安装包校验和、多语言切换。

---

## 6. 明确不建议 / 已定案不做

- **哨兵 / 集群**：用户明确「不做了」，不要写进规划或重新提案。
- **新增 `CacheEngine` 类型**：走 Redis 型号识别；Aerospike 是唯一独立新引擎候选，尚未拍板。
- **全量重写**：当前已是 Vue→React 移植式重写后的 React 19 版本。
- **删除 Vue 时代日志 / 坑位记忆**：NSIS、scoped 平铺、凭据解密等根因只记录在那里。
- **为性能到处手写 `memo`**：React Compiler 已定案（用户接受体积增量）。
- **擅自移动 / 删除已推送的标签、本地 `dist:win:publish`**：发版红线。
- **主动重启**：皮肤自适应图标、像素字体加粗、标题前加图标（用户已明确取消）。
- **未经确认跑全量测试 / 升版本 / 打包 / 提交推送**：交付闸门四条。

---

## 7. 建议推进顺序（与 M7 衔接）

| 阶段 | 内容 | 前置 |
| --- | --- | --- |
| 0 | **M7 收口**：v1.1.0 已发版，但「全量回归（M5/M6）、全量测试、打包自检」的执行结果未见记录 → 先补一份回归报告 | 全量测试需用户当轮明确点名 |
| 1 | 低风险 P1：校验脚本进 CI、死动画类、`--color-destructive`、契约一致性脚本、README 自检 | 逐项方案 / 直接小改 |
| 2 | Electron 一步到位 45.2.2（独立 feature 分支，打包版一次性完整验证） | 方案 D1…Dn + 回滚路径 |
| 3 | e2e 冒烟 6 条 + 大组件拆分方案 | 方案先行 |
| 4 | 型号识别 P0 / P1 | 已有定案，等开工指令 |

每条都按 `docs/conventions.md` 第 10 节 17 条检查清单执行；一轮改动一次提交，
验证通过后等明确指令才提交 / 推送。
