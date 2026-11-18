# Keyper v1.1.9 全量测试与审查清单

审查基线：git `1441467`（v1.1.9 + CI jq 修复）· 2026-11-18 · 全量自动化检查 + 源码逐行核查 + 浏览器实测（dev mock 与生产 dist 双通道）
方法：每项发现均附 文件:行号 或实测数据；「确认」= 源码/实测坐实，「疑点」= 需真实 Redis/SSH 环境复验。
上一轮审查（research/keyper-perf-review_final.md，v1.1.4 基线，22 项）已逐项复核：**19 项已修复**，3 项残留并入本清单（见 §5）。

---

## 0. 全量测试结果（全部通过）

| 检查 | 结果 |
|---|---|
| 单元测试 | ✅ 24 spec / 269 用例过，27 跳过（connectionManagerPerf 需 Docker Redis 实例，本机无） |
| typecheck（web + node 双工程） | ✅ 0 错误 |
| i18n 校验 | ✅ 1695 语义 key，三语键集/占位符/源码引用一致 |
| 样式规范 | ✅ 15 项断言全过 |
| CSP hash | ✅ meta 与内联脚本一致 |
| e2e 冒烟（CDP 无头） | ✅ 11 条断言全过（启动/双引擎/六类值/切标签/删除确认/主题） |
| 生产构建 | ✅ vite build + electron-builder 出包正常（release/1.1.9-final） |
| 浏览器实测（dev mock） | ✅ 六类值渲染、CLI 执行、FLUSHDB 短语确认、搜索过滤、设置四组切换、连接弹窗 SSH 展开滚轮、Memcached 树形展开/值查看/三页签、监控采样开启出点 —— 控制台 0 错误 |
| 浏览器实测（生产 dist） | ⚠️ 功能正常但见 BUG-1（mock 空壳崩溃）与 BUG-2（CSP 内联样式告警） |
| npm audit（生产依赖） | ✅ 0 漏洞 |
| npm audit（含 dev） | ⚠️ 16 项（2 critical / 7 high），全部在开发工具链，见 UPG-1 |

---

## 1. BUG —— 确认的问题（按严重度）

### BUG-1 · P1 · 生产包在纯浏览器环境直接崩（mock 空壳无防御）
- 位置：`vite.config.ts:56-76`（strip-mock-in-production 插件返回 `export const mockApi = {};`）；`src/api/index.ts:76`（`bridge ? wrapApi(bridge) : mockApi`）
- 实测：python http.server 服务 dist/ 打开 → `PAGEERROR: Cannot read properties of undefined (reading 'getEnvInfo')`（WelcomePanel.tsx:126）、`reading 'get'`（settings.ts:119）、`reading 'dir'`（SettingsDialog），点「检查更新」触发根级渲染错误。首屏能挂载但连接列表恒空、设置/更新面板必崩。
- 影响：Electron 生产包不受影响（有 bridge）；但「dist 直接部署到静态服务器做在线演示」这条路完全不可用，且报错是裸 TypeError 而非友好降级。
- 修法：二选一——① 空壳改为带兜底的 Proxy（任何方法返回 `{ok:false,error:'浏览器预览请运行 npm run dev:web'}`）；② 或在 api/index.ts 检测 `!bridge && Object.keys(mockApi).length===0` 时渲染明确的「此构建仅支持 Electron」提示页。约 15 行。

### BUG-2 · P2 · 生产 CSP 拦内联样式：首帧主题脚本的 colorScheme 写入被拒（每次启动 1 条告警）
- 位置：`index.html:34/42`（首帧脚本 `document.documentElement.style.colorScheme = theme`）；`scripts/csp-hash.mjs:36`（`style-src 'self'` 无 unsafe-inline/hash）
- 实测：dist 页面每次加载必现 1 条 `Applying inline style violates ... style-src 'self'`（violation 定位 line 75 = 打包后首帧脚本）；CSSOM setProperty（--fs-base 等）不受影响，字号/密度/皮肤切换实测全部生效、0 新增告警。
- 影响：仅首帧脚本里 `style.colorScheme` 这一句被拦（dataset.theme 赋值成功，主题本身不丢）；React 启动后 theme.ts:117 会再写一次 colorScheme（CSSOM 路径，不受 CSP 限制）补上。实际视觉影响≈0，但控制台有恒定噪音，且与 docs/csp-fix-plan.md「观察项」记录一致——本次已稳定复现（每次 1 条），可从观察项转正。
- 修法：首帧脚本改用 `document.documentElement.setAttribute('data-scheme', ...)` + CSS `[data-scheme=dark]{color-scheme:dark}`；或给 style-src 加该脚本的 hash（需 csp-hash.mjs 支持 style 属性 hash，成本更高）。推荐前者，约 6 行。

### BUG-3 · P1 · CLI 的 AUTH 命令明文进操作日志与 CLI 历史
- 位置：`electron/ipc/index.ts:241-242`（`detail: String(args[1])` 原样记录整条命令）；`electron/services/cli-history-store.ts:56-70`（recordCliHistory 原样存盘）；`electron/services/log-service.ts:53`（sanitize 只去换行/竖线，不脱敏）
- 复现路径：CLI 输入 `AUTH mypassword` → 操作日志 yyyymmdd.log 出现 `AUTH mypassword`，cli-history.json 同样明文。日志面板/导出/日志目录打开都会暴露。
- 影响：凭据泄露面。连接配置里的密码已 enc2 加密，但 CLI 手敲 AUTH/HELLO AUTH 绕过了加密层。
- 修法：describe() 与 recordCliHistory 对 `AUTH`/`HELLO ... AUTH` 命令做参数打码（`AUTH ***`）；高危命令清单 DESTRUCTIVE_COMMANDS 同处维护。约 10 行 + 1 条单测。

### BUG-4 · P1 · SSH privateKey 明文落盘（roadmap 1.4 已记录，仍未实施）
- 位置：`electron/services/connection-store.ts:100-108`（sealSsh 只加密 password/passphrase，`...ssh` 展开使 privateKey 原样透传）；hops 同理（L125-126）
- 实测：config/connections.json 中 ssh 对象含 privateKey 字段（本机该字段为空串，但代码路径对非空值不加密）。
- 影响：私钥即凭据，明文落盘与密码加密的设计意图不一致；配置文件被拷走即泄露。
- 修法：sealSsh/sealHops 增加 `privateKey: encryptPassword(ssh.privateKey)`，unseal 对称；兼容旧明文（读时检测无 enc 前缀则原样返回并改写）。注意 roadmap 提示的「undefined 保留旧密文」语义。约 20 行 + 迁移单测。

### BUG-5 · P2 · 主连接端口未校验（SSH 端口已校验，主端口漏网）
- 位置：`src/components/ConnectionDialog.tsx:246`（canSubmit 只查 name/host/sshError）；L543（`port: Number(event.target.value)`，input min/max 只是 UI 约束不拦截提交）；主进程 `connection-manager.ts:644 connect()` 与 memcached manager 均无端口范围校验
- 复现路径：端口填 0 / 99999 / 清空（Number('')=0）→ 可保存可连接，ioredis 抛底层 ECONNREFUSED/RangeError，用户看到的是网络错误而非「端口非法」。
- 影响：错误提示误导；非法配置落盘。SSH 跳板端口已有完整校验（L234/240），主端口是遗漏。
- 修法：canSubmit 增加 `Number.isInteger(form.port) && form.port>0 && form.port<=65535`，payload 前同查；主进程 connect 入口兜底。约 6 行。

### BUG-6 · P2 · 隐藏标签的 5s 自动刷新不停表（实测坐实）
- 位置：`src/components/ValueViewer.tsx:1338-1343`（autoRefresh effect 只依赖 [autoRefresh]，无 active/hidden 门控）；`Workspace.tsx:86-87`（hidden 只写 display:none，不卸载）
- 实测：A 标签开自动刷新后切到 B 标签，隐藏 A 的 DOM 11 秒内 95 次 mutation（可见时 87 次，同量级）——刷新与重渲染照常进行。Activity 只包住 ValueDetailPane 的「键书签显隐」，同一标签内隐藏 pane 的 effect 被 React 暂停，但**跨标签**的 display:none 不触发 Activity 暂停。
- 影响：多标签各开自动刷新时，后台标签持续打 Redis（每 5s 一次 refreshSelected + 全列表 map 复制 L760），SSH 场景白耗流量与 RTT；监控卡片已有 active 门控（MetricsCard L824 `if (!active...)`），值区是漏网。
- 修法：tickAutoRefresh 开头加 `if (!active) return`（ValueDetailPane 已有 active prop）；或 effect 依赖加 active。2 行。注意产品定案「切回零重建」，只停表不清状态。

### BUG-7 · P2 · 连接删除后 expandedPaths 成孤儿（settings.json 缓慢膨胀）
- 位置：`electron/ipc/index.ts:675-701`（connectionRemove 清理了 searchHistory/favorites/cliHistory 三桶，独漏 expandedPaths）；`src/components/KeyBrowser.tsx:361`（scope = `connId@db`）
- 影响：每删一个连接，其 16 个 db 的展开快照永久留在 settings.json；每次 settings 保存都全量序列化这堆死数据。量级小但属「清理不成对」缺陷，与同函数里三桶清理的设计意图不一致。
- 修法：connectionRemove 里按 `id@` 前缀删 expandedPaths 键并 saveSettings。约 6 行。

### BUG-8 · P3 · connection:status IPC 对 Memcached 恒 false（潜伏，当前无调用方）
- 位置：`electron/ipc/index.ts:904`（只查 connectionManager.isConnected）；roadmap 2.4 已记录
- 实测：渲染层当前无任何 `api.connection.status()` 调用（grep 0 命中），属死通道；但 preload/mock 都暴露了它，未来一旦使用即踩坑。
- 修法：handler 改 `connectionManager.isConnected(id) || memcachedManager.owns(id)`；或干脆删掉这条无人用的通道（132 条 IPC 里减 1）。

### BUG-9 · P3 · Memcached 键列表容器类名与 Redis 不一致（自动化/测试脆弱点）
- 实测：Redis 键列表 `.key-list-scroll`，Memcached 是 `.key-list`（无 -scroll），平铺行也不是 `.key-item`。e2e 与本次浏览器探针都要为两套 DOM 各写一套选择器。
- 影响：非用户可见 bug，但 roadmap 2.1 双引擎重复组件的又一症状；测试覆盖 Memcached 侧成本更高。
- 修法：并入 UPG-4 双引擎公共骨架抽取，不单独修。

---

## 2. 性能 —— 残留与新增（上一轮 19 项已修复，勿重复动）

### PERF-1 · P1 · memoryAnalysis 串行批 + 无进度 + 无取消（上轮 #13 残留）
- 位置：`electron/services/connection-manager.ts:1002-1060`
- 现状：SCAN 2000/批 → 每 100 键 pipeline MEMORY USAGE 串行 await，上限 10k 键；无进度推送、无取消令牌（searchTokens/bulkTokens 机制已存在可复用）。SSH 下 100 批 × 50-150ms ≈ 5-15s 白等且不可中止。
- 修法：批间 2-4 路并发 + 复用取消令牌 + 进度节流推送（UI 已有 remote-bar 先例）。预期耗时减半以上。

### PERF-2 · P2 · settings 每次保存全量同步写盘（上轮 #6 部分残留）
- 位置：`electron/services/settings-store.ts:113-115`（writeFileSync + mkdirSync 每次调用）
- 现状：读已缓存（L63-70），写仍同步。触发频率已被上游收敛（拖拽 onCommit 才写、树展开 400ms 防抖 KeyBrowser L420-428），但每次仍是主进程同步 IO + 全量 JSON.stringify（含 expandedPaths 死数据，见 BUG-7）。
- 修法：写改异步队列（log-service enqueueAppend 先例）+ 退出 flush；或 200ms 防抖合并。低风险。

### PERF-3 · P2 · 主 bundle 1.5MB 单 chunk（上轮 #16 部分修复）
- 位置：`dist/assets/index-DzXU-fOB.js` 1,499,578 B；`vite.config.ts` 无 manualChunks
- 现状：mock 已被 strip-mock-in-production 插件剔除（上轮建议①已做，且比动态 import 更彻底）；但 motion/radix/六类值编辑器/概览/Lua 弹窗仍全量进首屏 chunk。
- 修法：manualChunks 拆 vendor（motion/radix/lucide 约 400-500KB）；ValueViewer/概览/Lua 弹窗 React.lazy。注意 Activity 保活定案——lazy 只影响首次加载，不破坏保活。预期首帧解析量降 30-40%。

### PERF-4 · P3 · refreshSelected 后全列表浅复制（上轮 #9 同型漏网）
- 位置：`src/store/session.ts:760`、`session.ts:952`（`state.keys = state.keys.map(item => ({...item}))`）
- 现状：5s 自动刷新/加载更多后，为触发 TTL 重算把最多 5000 键整表 map 复制 + 一次全量广播。TTL 显示已由 useTtlClock 共享时钟驱动（每秒本地重算），这两处复制的实际收益存疑。
- 修法：先验证去掉后 TTL 列是否仍随钟走（useTtlClock 订阅面）；若确需触发，改 bump 单字段版本而非整表复制。需运行时验证，标疑点。

### PERF-5 · P3 · KeyBrowser/ValueViewer 整店订阅（上轮 #8 部分修复）
- 位置：`src/components/KeyBrowser.tsx:86`、`ValueViewer.tsx:122/980`（useObservable 整店）；字段级订阅 useSessionFields 已存在但只有概览三卡在用（KeyspaceCard/MemoryCard/MetricsCard/ServerOverview）
- 现状：store 已有 fieldVersions + batch（reactiveStore.ts:49-95），基础设施齐备；键列表/值区这两个最重组件仍整店订阅——CLI 每行输出、搜索每批进度都触发它们重渲染（React Compiler 挡不住订阅源变化）。
- 修法：KeyBrowser 改 useSessionFields(['keys','remoteKeys','pattern','activeDb','loadingKeys','cursor',...])；ValueViewer 同理列字段。字段清单需逐组件核对读面，工作量中等，收益高频场景渲染降一个量级。

---

## 3. 安全加固建议（非漏洞，防御纵深）

### SEC-1 · P2 · SSH 首连不校验主机指纹、变更不告警
- 位置：`electron/services/ssh-tunnel.ts:119-121`（注释自认「允许首次连接的未知主机」，无 hostVerifier）
- 现状：ssh2 默认接受任何主机密钥；中间人可冒充堡垒机。注释说「安全性由提示弥补」但代码里没有任何指纹记录/变更检测。
- 修法：首次连接记录指纹到连接配置（knownHosts 字段），后续连接 hostVerifier 比对，变更时弹确认（展示新旧指纹）。桌面应用可做 TOFU（trust on first use）。约 40 行 + UI 确认框复用 askConfirm。

### SEC-2 · P3 · 更新 FEED_URL 环境变量未限定 https
- 位置：`electron/services/auto-update.ts:29-31,94-99`（KEYPER_UPDATE_URL 直接 setFeedURL，无协议校验）
- 现状：electron-updater 对 exe 有 sha512 校验（latest.yml），http 源被篡改时校验会失败，实际风险低；但 latest.yml 本身可被替换（含 sha512），http 源存在完整供应链替换窗口。
- 修法：FEED_URL 非 https 时拒绝启用并 console.warn（内网 http 源属明确的用户自担场景，可加 KEYPER_ALLOW_HTTP_FEED=1 显式开关）。约 6 行。

### SEC-3 · P3 · 操作日志记录键值类操作的字段名/成员名（业务数据落日志）
- 位置：`electron/ipc/index.ts:282-290`（redisSetHashField detail 含 field→nextField）
- 现状：字段名通常非敏感，但「日志保留 30 天 + 可导出」意味着业务元数据长期落盘。与 BUG-3 同根：describe() 无脱敏层。
- 修法：随 BUG-3 一起引入「detail 脱敏钩子」，按通道配置哪些参数打码。低优先。

---

## 4. 升级与依赖（registry 实测 2026-11-18）

### UPG-1 · P1 · 开发工具链 16 项 audit 告警（2 critical），生产依赖 0 漏洞
- 实测：`npm audit --omit=dev` = 0；全量 16 项全部在 devDependencies 链：
  - **vitest 3.2.7 → 5.1.0**（critical：tinypool 原型污染 RCE GHSA-5gmw-xhrv-c9v3 / GHSA-85c8-ppgw-ccpr；moderate：@vitest/mocker 路径遍历 GHSA-82fw-gwwq-j7x9）。仅测试运行时受影响，不进安装包。vitest 5 是大版本，需验证 24 spec 兼容（environmentMatchGlobs 等配置项可能改名）。
  - **vite 6.4.5 → 6.4.6**（high：picomatch ReDoS GHSA-fc5q-39xc-vjpf，经 fdir/tinyglobby 传递）。补丁级，`npm update vite` 即可；6.4.6 依赖范围 ^4.0.2 仍解析到 picomatch 4.0.7（当前已装 4.0.7，audit 仍报是因为 advisory 范围 <=4.0.7 无修复版——**此项实际无可修版本，等上游**，升级 vite 补丁不能消除，需 overrides 或忽略）。
  - **electron-builder 26.18.1**（moderate/high 经 app-builder-lib→node-gyp/minimatch）：audit 建议降级 25.1.0 是误导（26.x 修复版未发），保持现状等上游。
  - **geist 1.8.2 → 1.9.2**：peer 依赖 next >=13.2 被 npm 自动装了 next@16.4.3（203MB，moderate 告警源）。项目只用 geist 的 woff2 字体文件（geist-pixel.css:19 直接 url 引用），next 完全无用。修法：package.json overrides 禁 next，或把 5 个 woff2 拷入 src/assets 后移除 geist 依赖——省 203MB 安装体积 + 消 2 条告警。
- 建议顺序：geist 去 next（立即可做）→ vite 6.4.6（补丁）→ vitest 5（单独分支验证）→ electron-builder 等上游。

### UPG-2 · P1 · Electron 45.2.2 → 45.3.4（同大版本补丁，含安全修复）
- registry 实测：45.3.4 发布于 2026-11-17（昨天）。45.3.1 含「停止信任 eMudhra 被吊销 RSA 中间证书」（对应 CVE-2026-115570 HIGH 7.4 的后续加固）；45.3.2 升级 Chromium 156.0.8078.100 + ANGLE/Dawn/Skia/V8 上游修复；45.3.3 Node 24.22.3；45.3.4 修右键元素泄漏。
- 项目 45.2.2 发布于 11-03，落后 4 个补丁。应用走 TLS 连 Redis/更新通道，证书信任加固直接相关。
- 修法：`npm i -D electron@45.3.4` → 全量测试 → 打包验证（项目有 electron-45-upgrade.md 升级清单先例，补丁级风险低）。

### UPG-3 · P2 · 常规依赖小版本
- motion 14.7.1 → 14.14.0、lucide-react 1.63.0 → 1.75.0、tailwindcss 4.3.3 → 4.3.5、@tailwindcss/vite 同步、geist 1.9.2（见 UPG-1）、@babel/parser 7.29.14。均为 minor/patch，随下次发版车一起升。
- ioredis 5.11.1 → 6.0.0 是大版本，**不建议**跟（生产依赖 0 漏洞，6.0 破坏面未知）；vitest 5 见 UPG-1；vite 8 / @vitejs/plugin-react 6 / jsdom 31 同理等稳定窗口。
- package-lock.json 根版本仍 1.1.4（历史漂移，roadmap 3.6 已记录）：发版脚本应同步 `npm install --package-lock-only`。

### UPG-4 · P2 · 结构性债务（roadmap 已定案，复核仍在）
- ValueViewer 2686 行 / KeyBrowser 1707 行 / MemcachedValueViewer 1370 行 / MemcachedKeyBrowser 1227 行——双引擎四件套约 7000 行，公共骨架（键列表虚拟化/搜索栏/视图切换）可抽（roadmap 2.1，需先出方案）。
- components.css 412KB / 14882 行：实测 13 个旧弹窗前缀（s-confirm-dialog 等）307 条规则 / 47KB 在 tsx 中 0 引用，可安全裁剪（上轮 #22 裁了双形态选择器，这批是另一批死代码）。
- ui/dialog.tsx、ui/select.tsx 仍用全库无定义的 animate-in/zoom-in-95 死类（roadmap 2.5）：装 tw-animate-css 或删类，弹窗入场动画当前实际不存在。
- --color-destructive 映射 var(--accent)（tailwind.css:79，roadmap 2.6）：危险按钮与强调色同色，9 套皮肤下「清空全部数据」看起来像普通主按钮。
- 132 条 IPC 通道五处手工联动（roadmap 2.3）：本次实测 preload/ipc/mock 三处键集一致（position 是参数名误匹配），但无自动守护脚本，新增通道仍靠人肉。

### UPG-5 · P3 · 测试金字塔缺口
- 27 个 connectionManagerPerf 用例因无 Docker 实例跳过：CI（ubuntu）可加 redis service container 让它们真跑（GitHub Actions services: redis:7-alpine 一行配置）。
- 组件层 0 测试：24 spec 全是纯函数；BUG-6（隐藏标签停表）这类交互回归只能靠手测。最低成本补法：@testing-library/react 已装，给 ValueViewer 的 autoRefresh 门控、SettingsDialog 分组切换写 3-5 条 jsdom 用例。
- e2e 11 条已进 CI（roadmap 3.1 已落地）；ci.yml:62 注释仍写「6 条冒烟」，实际 11 条，注释漂移。
- README 回归数字漂移：写「24 spec / 1687 key」，实际 25 个 spec 文件（24 跑 + 1 跳过）/ 1695 key（roadmap 3.7 的 CI 比对脚本仍未做）。

### UPG-6 · P3 · 仓库卫生
- 本地 main 分支停在 v1.1.4（38ef06d），落后 master 31+ 提交；远端 github/master 停在 64c7f9c（perf-phase2 合并点）。双主干易误推，建议删远端 master 或明确 main 为唯一主干（本次发版已走 master:main）。
- 15 个已合并 feature 分支未清理（git branch --merged 列出）；.pack-tmp/ 405MB、_lock-test.asar 112KB 未跟踪遗留物在工作区（.gitignore 已挡 nul/stackdump，这两个没挡）。
- research/ 审查工件已入库（上轮），本轮清单沿用该目录。

---

## 5. 上轮 22 项复核结论（v1.1.4 → v1.1.9）

**已修复 19 项**（逐项源码核实）：#1 大值 STRLEN+GETRANGE 限量（connection-manager L1572-1653）、#2 异步解压（L91-92 + mc manager L507-515）、#3 微操作 pipeline（addZsetMember L2224 等）、#4 批量下沉主进程 redis:bulk（session L1177-1240）、#5 prettyJson/utf8Bytes memo（string.ts L45-46）、#6 日志异步队列+每日 prune（log-service L127-173/316）、#7 mc 收包 chunk 数组（client L106-208）、#8 部分（batch+fieldVersions 基础设施）、#9 整批赋值（session L592）、#10 Context 按 session 缓存（Workspace L40-43）、#11 树虚拟化+Collator（KeyBrowser L755-770 / keyTree L78）、#12 MULTI+分片（L1927-1976）、#14 合帧缓冲（PubsubCard L94 / KeyspaceCard L184）、#15 storeBatch（settings.ts L121-140）、#16 部分（mock 剔除）、#17 parseInfoFields Map（L98-101）、#18 clearTimeout（L519-528）、#19 进度节流（L77/1398）、#20 COMMAND_CHUNK=500（L76）、#21 单定时器（SlowlogCard L506-513）、#22 双形态裁剪 604 条（v1.1.6）。

**残留 3 项**并入本清单：#13→PERF-1、#6 写盘部分→PERF-2、#16 分包部分→PERF-3。另 #8 的订阅面收敛→PERF-5。

---

## 6. 建议实施顺序

1. **立即（小改动高收益）**：BUG-3 AUTH 打码（10 行）→ BUG-5 端口校验（6 行）→ BUG-6 停表（2 行）→ BUG-7 expandedPaths 清理（6 行）→ UPG-1 geist 去 next（省 203MB）
2. **下个补丁版**：BUG-4 私钥加密（含迁移测试）→ UPG-2 Electron 45.3.4 → BUG-1 mock 空壳兜底 → BUG-2 首帧 colorScheme 改 data 属性 → SEC-1 SSH TOFU
3. **单独分支**：PERF-1 内存分析并发+取消 → PERF-3 分包 → PERF-5 字段订阅收敛 → UPG-1 vitest 5 → UPG-4 死 CSS 裁剪 307 条
4. **随车**：UPG-3 小版本、UPG-5 CI redis service、UPG-6 分支清理

每项独立可回滚；涉及 Activity 保活、双引擎重复、React Compiler 的改动遵守 roadmap「先方案确认」定案。

## 证据限制

- 浏览器实测基于 mock 数据（dev:web 与生产 dist），未连真实 Redis/SSH 做 profiling；PERF 类收益为 RTT/复杂度推断（50-150ms/RTT 为项目历史实测口径）。
- BUG-6 的 mutation 计数含 TTL 时钟每秒重算的底噪，但可见/隐藏同量级（87 vs 95）足以证明刷新未停；精确请求数需真实连接抓 IPC。
- npm audit 的 picomatch 项当前无修复版本（advisory 范围 <=4.0.7，最新即 4.0.7），升级 vite 不能消除，已如实标注。
- Electron 45.3.x 修复内容取自 GitHub Releases API 官方发布说明（45.3.0/45.3.1/45.3.2/45.3.3/45.3.4 逐版核对）。