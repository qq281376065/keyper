# Electron 33 → 45 升级执行方案（分支 `feat/electron-45-upgrade`）

> 状态：**阶段 1 已完成**（依赖升至 45.2.2，typecheck / 目标单测 / 构建 / CSP 全过）。
> **D2 已定案（2026-11-04 用户拍板）：不走阶梯，直接一步到位 45.2.2**；D3 已确认延后到 46 前。
> 阶段 2 的代码与运行时验证已完成，打包受宿主删除钩子阻断（需普通终端执行）；
> **尚未提交、推送、打标签**。
> 本文件不写产品版本号（以 `package.json` 与 `git log` 为准）。
> 配套：`docs/roadmap.md` 第 1.1 条、`docs/conventions.md`（项目基线）、`docs/architecture.md`。
> 所有动作受 `docs/conventions.md` 第 1 节交付闸门约束。

## 0. 为什么单独开分支

代码层面直接改动小，**但验证工作量大**：跨 12 个大版本、Node 20→24、Chromium 130→156，
且项目有多处与 Electron 运行时强耦合的机制（CSP 双通道、`safeStorage`/DPAPI 凭据、
sandboxed preload、NSIS 打包、自动更新）。按项目惯例，大功能放独立 feature 分支，
验收前不合并、不推送；分支可整体丢弃，回滚成本最低。

- 基线与回滚锚点：分支创建于 `e4cd37c`（与 `main` 同 HEAD），**尚无提交**。
- 回滚：丢弃分支即可；若已改依赖，`git checkout main -- package.json package-lock.json` 恢复。
  Electron 二进制在用户级缓存，不污染源码；`config/` 凭据目录全程不动（升级前另行备份）。

## 1. 本轮已完成的动工（只读 + 新增工具，未改产品代码）

1. 创建分支 `feat/electron-45-upgrade`。
2. 新增 `scripts/check-electron-upgrade.mjs`：零依赖、不联网、不截图、不写文件的静态预检，
   覆盖 34–45 中可用源码判定的 breaking changes。`--strict` 时遇到硬阻断返回退出码 1。
3. 实跑结果：**扫描 156 个源码文件，硬阻断 0 项，需验证或排期 2 项**。

| 检查项 | 结果 |
| --- | --- |
| 44 renderer 直接用 electron `clipboard` | 未命中（渲染层统一 `navigator.clipboard`，主进程权限按 W3C 名放行） |
| 45 sandboxed preload 用 Node shims / `Buffer` / `setImmediate` | 未命中（`sandbox:true` 已开，preload 只用 `contextBridge` + `ipcRenderer`） |
| 35 `WebRequestFilter.urls: []` | 未命中（`onHeadersReceived` 无 filter 的两参数形式） |
| 44 已移除 API（isUnityRunning / PrinterInfo / routingId / getBitmap） | 未命中 |
| 45 ASAR 内 fd 交给非 fs 消费者 | 未命中 |
| 36 `app.commandLine`、44 `Sec-Fetch-Dest`、39/45 `window.open` | 未命中 |
| **45 `safeStorage` 同步 API**（弃用，46 移除） | **命中 4 处**：`electron/services/credential-crypto.ts:124/146/148/249` |
| **43 dialog 缺 `defaultPath`** | **命中 1 处**：`electron/ipc/index.ts:753` 的 `showOpenDialog`（3 处 `showSaveDialog` 均已传） |

> 预检只覆盖静态可判定项。Node / Chromium 大版本跳跃、三个打包链依赖的兼容性、
> NSIS 与 CSP 双通道、旧密文解密、9 套皮肤视觉回归，仍必须靠打包版一次性真机验证。

## 2. 待决策点（确认后进入阶段 1）

| 编号 | 决策 | 选项与推荐 |
| --- | --- | --- |
| **D1** | 目标版本 | **45.x（推荐）**：官方当前稳定线，EOL 最晚；43.x 仍在支持窗口但 2027-01 到期；保持 33 不可接受（已 EOL） |
| **D2** | 升级路径 | **已定案（2026-11-04 用户拍板）：不走阶梯，直接一步到位 45.2.2**。原推荐的阶梯 33→36→40→43→45 作废；代价是出问题时无法二分定位，用一次完整回归 + 独立分支整体回滚兜底 |
| **D3** | `safeStorage` 异步化 | **已确认延后到 46 前单独排期**（用户 2026-11-04 拍板）：实测牵动整条同步凭据链，见附录 A；45 只弃用、46 才移除，预检保留 1 项 warn 作提醒 |
| **D4** | 外部依赖 | **先核实最小升级集（推荐）**：只动 `electron` + `@types/node`，`electron-builder` / `electron-updater` / `vite-plugin-electron` 按实测结果决定；或三个一起升到最新（回归面更大） |
| **D5** | 打包验证范围 | **仅 win NSIS x64（推荐，项目主要分发）**；或加 mac dmg + linux（44 起 macOS 最低 13、ANGLE 静态链接，成本明显上升） |
| **D6** | 发布节奏 | **升级独立成一个版本发布（推荐）**，便于回滚与定位；或搭车下一个功能版本 |
| **D7** | `showOpenDialog` 的 `defaultPath` | **随第一级顺手补（推荐，低风险小改）**；或保持现状接受「默认打开 Downloads」的新行为 |

## 3. 确认后的真实改动清单（预估 5–8 处）

1. `package.json`：`devDependencies.electron` → 目标版本、`@types/node` → 24.x；
   **产品 `version` 字段一律不动**（交付闸门）。
2. `package-lock.json`：随依赖安装更新；安装后核对根 `version` 与 `package.json` 一致。
3. `electron/services/credential-crypto.ts`：按 D3 迁移 4 处同步 `safeStorage` 调用，
   牵动 `connection-store` 的取密钥路径，**必须保留 `enc:` / `enc2:` 旧密文可解**。
4. `electron/ipc/index.ts:753`：按 D7 补 `defaultPath`。
5. `electron/main.ts`：复核 CSP 响应头 + `index.html` meta 双通道、权限策略、
   `titleBarStyle:'hidden'` 自绘标题栏；预计无需改，但要实测。
6. `tsconfig.node.json` / 类型：修复 Node 24 类型变更带来的编译错误。
7. `electron-builder.yml` / NSIS：按 44 的 ANGLE 变化核对 DLL 清单，
   并更新「360 误报清单」这条历史记录（不涉代码）。
8. `docs/roadmap.md`：升级完成后回填实际结论与残留风险。

**明确不在本轮做**：不改产品版本号、不打包、不推送、不提交、不跑全量测试（除非当轮点名）、
不动 `config/` 凭据、不动已推送标签。

## 4. 固定验证清单（一步到位：本轮一次性跑完）

| # | 验证项 | 判据 |
| --- | --- | --- |
| 1 | 旧凭据解密 | 用现有 `config/connections.json` 的 `enc2:` 密文解密成功，并真实连上 Redis / Memcached |
| 2 | preload 参数清洗 | `window.redisApi` 暴露完整，invoke 往返正常，Proxy 参数不报 `DataCloneError` |
| 3 | CSP 双通道 | 开发态响应头 + 生产 `file://` 的 meta 都生效，首屏主题脚本不被拦（无亮暗闪烁） |
| 4 | 打包与安装 | NSIS 安装包能装、能启动、无 360 新增拦截项；`app.asar` 内容可解包核对 |
| 5 | 自动更新 | `releases.atom` → `releases/download/<tag>/latest.yml` 未认证可取，草稿/重复 Release 检查通过 |
| 6 | 调试与视觉 | `--rd-debug` 起 DevTools；9 套皮肤、像素字体、自绘标题栏、`--lift-shadow` 无回归 |

附加：本轮一次性跑 `node scripts/check-electron-upgrade.mjs --strict`（硬阻断必须为 0）、
`npm run typecheck`（两工程）、`npm run i18n:check`、目标单测；
**不跑全量套件**，除非用户当轮点名。UI 核对只用 DOM / 计算样式证据，**不截图**。

## 5. 阶段与工时（单人估算，非承诺）

| 阶段 | 内容 | 估算 |
| --- | --- | --- |
| 0 | 分支 + 预检工具 + 本方案（**已完成**） | — |
| 1 | 确认 D1–D7 → 改依赖 / 安装 / typecheck 修错 | 0.5–1 人日 |
| 2 | 一步到位 45.2.2，跑一次第 4 节完整验证清单 | 1–2 人日（不含宿主环境阻断的打包） |
| 3 | UI / CSP / 凭据回归、文档回填、发版（需授权） | 1 人日 |

## 6. 外部依赖待核实项（D4 的输入，本轮未验证）

- `electron-builder` 26.18.1、`electron-updater` 6.8.11、`vite-plugin-electron` 0.29
  对 Electron 45 的兼容性 —— 需查各自发布说明 / 实测，**不要凭版本号推断**。
- Electron 42 起 npm 包不再 `postinstall` 下载二进制，CI / 打包机需验证下载时机与网络。
- 44 起 win32-ia32 / linux-armv7l 预构建包移除（项目 win 仅 x64，mac dmg 最低 macOS 13）。
- 45 起 `safeStorage` 同步 API 弃用、46 移除（D3 的依据）。

## 7. 阶段 1 之前的额外前置

`scripts/` 整体被 `.gitignore` 忽略：预检脚本若要入库必须 `git add -f`，
或改造成 `npm run check:electron` 并接进 CI。是否入库需单独指令，本轮未 add。

---

**当前状态（2026-11-04）**：D1–D7 已确认，阶段 1 与 CSP 修复已完成并验证通过
（见附录 A 与 `docs/csp-fix-plan.md`）。阶段 2 只剩打包与打包版验证：
`npm run dist:win:alt` 需在不受宿主 `safe-delete` shim 影响的普通终端执行，
之后按第 4 节清单一次性验完。提交、推送、打标签一律等当轮明确指令。

---

## 附录 A · 阶段 1 执行记录（2026-11-04，用户确认「按推荐项」）

### 已落地的改动（3 个文件，产品 `version` 保持 1.1.0）

| 文件 | 改动 |
| --- | --- |
| `package.json` | `electron ^33.2.1 → ^45.2.2`、`@types/node ^22.10.2 → ^24.19.2`、`engines.node >=18 → >=22.12.0`（Electron 45.2.2 硬性要求）。仅 3 行，JSON 解析校验通过 |
| `package-lock.json` | 随 `npm install` 更新（+77 / −126），根 `version` 仍 1.1.0 |
| `electron/ipc/index.ts` | D7：新增模块级 `lastImportDir`，`connectionImportPick` 补 `defaultPath`，成功后记住 `path.dirname(filePath)`，恢复 43 之前的「记忆上次目录」体验 |

### 验证结果（全绿）

| 项目 | 结果 |
| --- | --- |
| `npm install` | 首次因 `EBUSY` 失败，诊断后移除占用源，重试成功（20s） |
| Electron 二进制 | `dist/version = 45.2.2`，`electron.exe` 249MB 已下载 |
| `npm run typecheck`（web + node） | **exit 0，零类型错误**（Node 24 / Electron 45 类型无需改代码） |
| `node scripts/check-electron-upgrade.mjs --strict` | **硬阻断 0**；dialog 项由 WARN 转 OK，仅剩 safeStorage 1 项 warn |
| `npm run i18n:check` | exit 0（1567 key / 1563 源码引用） |
| 目标单测（非全量） | `credentialCrypto` + `connectionTransfer` **29/29 通过** |
| `npx vite build` | exit 0，主进程 402KB / preload 11KB 正常产出 → `vite-plugin-electron` 0.29 可编译 45 项目 |
| CSP 双通道 | 按 CI 顺序补跑 `csp-hash.mjs` 后 `csp:check` exit 0（直接跑 `csp:check` 会假失败，与升级无关） |

### 三个环境事实（已实测，阶段 2 会再遇到）

1. **`EBUSY` 的来源**：PID 12932 是 `electron.exe serve-site.mjs 4321`，即用 Electron 作 Node
   跑的官网静态预览服务，锁住 `node_modules/electron/dist/icudtl.dat`。已停止该进程、
   安装完成后用**普通 node** `node scripts/serve-site.mjs 4321` 恢复（HTTP 200 已验证）。
   4 个生产版 `D:\Program Files\Keyper\Keyper.exe` 进程全程未动。
2. **`ELECTRON_RUN_AS_NODE=1` 仍泄漏**到本 shell：`node node_modules/electron/cli.js --version`
   输出的是 `v24.22.2`（Node 版本）而非 Electron 版本。阶段 2 启动 Electron 窗口前必须
   `unset ELECTRON_RUN_AS_NODE`，否则主进程 `app` 为 undefined。
3. **Electron 42+ 不再 postinstall 下载二进制**：`npm install` 只加包元数据，`dist/` 为空；
   首次运行 `cli.js` 才下载。CI / 打包机需确认网络与缓存策略。

### D4 外部依赖核实结果（本轮已查，不再列为未验证）

- `electron-updater` 6.8.11 = npm 最新 → 不动。
- `electron-builder` 26.18.1 ≥ npm 最新 26.18.0 → 不动（是否支持 45 仍需阶段 2 出包验证）。
- `vite-plugin-electron` 0.29（最新 1.2.0）→ **本轮 `vite build` 实测通过，按最小升级集不动**。
- Electron 45.2.2 `engines.node >= 22.12.0`；本机 Node 22.22.2、CI `node-version: 22` 均满足。

### D3 需要重新拍板（实测改动面远超预估，故本轮未改）

原以为只改 4 处同步调用，实测 `safeStorage` 处在**整条同步凭据链**上：
`readKeyFile` → `masterKey` → `encryptV2/decryptV2` → `sealSecret/unsealSecret` →
`connection-store.loadConnections/saveConnections` → 十余个 IPC handler。
改成 `encryptStringAsync` / `decryptStringAsync` 会把这条链全部变 Promise，
牵动十余个文件、影响旧 `enc:` 密文迁移与导入导出，**风险与本次升级目标不匹配**。

且 45 只是**弃用**同步 API，46 才移除。建议改为 D3 的另一选项：**延后到 46 前单独排期**，
本轮保持现状（预检里保留 1 项 warn 作为提醒）。
**用户已于 2026-11-04 回复「是」确认延后，D3 结案，不再属于本次升级范围。**

### 阶段 2 待办（打包已授权，卡在宿主环境）

- 打包（`dist:win:alt`）与 NSIS 安装启动验证 —— 用户已授权，但两次尝试均被宿主
  `safe-delete` shim 阻断，需普通终端执行（见附录 B）。
- 一次性 6 项验证清单，特别是旧 `enc2:` 密文解密 + 真实连接、CSP 双通道、`--rd-debug`、
  9 套皮肤视觉回归（DOM / 计算样式证据，不截图）。
- 44 起 ANGLE 静态链接 → 更新 360 误报清单；`dmg` 目标最低 macOS 13。
- 完成后回填 `docs/roadmap.md` 第 1.1 条的实际结论。

---

## 附录 B · 阶段 2 部分执行记录（2026-11-04，用户授权打包验证）

### 打包：两次尝试均被宿主环境阻断（非 Electron 45 问题）

| 尝试 | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npm run dist:win:alt` | 前端 / 主进程 / preload / csp-hash 全部成功；electron-builder 在解压 Electron 45 二进制后删除 `win-unpacked.tmp` 时失败 |
| 2 | `npx electron-builder --win -c.directories.output=release/e45-check` | 换全新目录仍失败，同一错误 |

错误来自 WorkBuddy 注入的 `node-safe-delete-shim.cjs`：它把 `fs.rm` 转成回收站操作，
对 electron-builder 的临时目录返回 `trash operation: Some operations were aborted`。
`NODE_OPTIONS` 里只有语言 shim，说明删除钩子由宿主另处注入，**本环境内无法绕过，也不尝试绕过**。
中间产物 `release/{1.1.0-final,e45-check}/win-unpacked` 各有 73 个文件（Electron 45 二进制解压成功），
但**没有 `app.asar`、没有安装包、没有 `latest.yml`** —— 打包未完成。
这两个目录含残留 `win-unpacked.tmp`，需要时可手动清理（本轮未删）。

### 等价运行时验证：Electron 45 二进制 + 生产构建产物（CDP 只读，不截图）

用 `unset ELECTRON_RUN_AS_NODE; node_modules/electron/dist/electron.exe . --remote-debugging-port=9233`
启动真实 Electron 45 窗口（生产 `file://` 路径），通过 CDP 读 DOM / 计算样式 / 控制台：

| 检查 | 结果 |
| --- | --- |
| 窗口与页面 | `title=Keyper`、`readyState=complete`、`.s-app` 存在、正文 7159 字符 |
| preload / contextBridge | `window.redisApi` 存在，13 组 API（含 `luaScripts`）完整 |
| 主题令牌 | `data-theme=light`、`--accent=#d0342c`、`--lift-shadow` 双层影值正确 |
| CSP meta | 存在，hash 已与浏览器要求值对齐（见下） |

### 发现并修复一处构建缺陷：CRLF 导致 CSP hash 不匹配

`dist/index.html` 的内联首帧主题脚本是 CRLF；`scripts/csp-hash.mjs` 按原始字节算 hash
（`sha256-HeNH9…`），浏览器按 HTML 规范把换行规范化为 LF 后算（`sha256-duieBj…`），
两者不一致 → 主题脚本被 CSP 拦下。已在 `csp-hash.mjs` 提取脚本时统一换行并加注释；
重跑注入后 meta hash = `sha256-duieBj…`，`csp:check` exit 0、typecheck exit 0。
**该缺陷与 Electron 45 是否引入无关**（CRLF 是 Windows 构建常态），是本次用 CDP 查控制台才暴露。

### CSP 拦截已修复（方案 A；验证清单第 3 项通过）

2026-11-04 按 `docs/csp-fix-plan.md` 的 D1–D5 推荐项实施方案 A：
`applyContentSecurityPolicy()` 对 `file:` 短路，不再给 `file://` 写响应头 CSP，
生产版只由 `index.html` 的 meta CSP 约束；`http://` 开发态与 `CSP_DEV` 不变。
根因已坐实为 45 / Chromium 156 起 `file://` 主文档也会触发 `onHeadersReceived`，
响应头 CSP（无 hash）与 meta CSP（有 hash）叠加取最严，拦掉首帧主题脚本。

CDP 两轮 reload 反证（`scripts/check-csp-runtime.mjs`，不截图）：主文档 CSP 响应头 `null`、
控制台 error 0（CSP 相关 0）、`html[style]` 含 `color-scheme: light`（首帧脚本已执行）、
meta 11 条指令与脚本 hash 完整、`redisApi` 13 组 / `--accent` / `--lift-shadow` 正常。
`style-src` 内联样式偶发项两轮均 0 条，按 D2 转为长期观察，不修。
静态校验：`vite build` / `csp:check` / `typecheck` / 预检 `--strict` 全 exit 0，目标单测 29/29。

### 阶段 2 未完成项（需用户在不受宿主 shim 影响的终端执行）

- 本地打包命令（在普通终端）：`npm run dist:win:alt`；若仍撞锁，用
  `npx electron-builder --win -c.directories.output=release/<新目录>`。
- 完成后验证：NSIS 安装启动、`app.asar` 解包核对、旧 `enc2:` 密文解密并真实连接、
  自动更新直链（`releases.atom` → `latest.yml`）、9 套皮肤逐套 DOM 回归、`--rd-debug`。
- CSP 双通道已修复并验证（security 错误 0），打包版仍需按 `scripts/check-csp-runtime.mjs`
  复验一次；`style-src` 偶发项按 D2 长期观察。
- **根因、修法对比与实施记录**：见 `docs/csp-fix-plan.md`（D1–D5 已按推荐项确认并落地）。



---

## 附录 C · 提交拆分预案（2026-11-04，等用户明确「提交」指令才执行）

分支 `feat/electron-45-upgrade` **零提交**，工作区 22 项混了三批改动，提交前必须拆开。
另外 `scripts/check-csp-runtime.mjs` 被 `.gitignore` 忽略，不在这 22 项里，需 `git add -f`。

### 批次归属

| 批次 | 主题 | 文件 |
| --- | --- | --- |
| **A** | Electron 45 一步到位升级 + `file://` CSP 回归修复 | `package.json`、`package-lock.json`、`electron/ipc/index.ts`（D7 的 `defaultPath`）、`electron/main.ts`（**仅 CSP 部分**）、`scripts/csp-hash.mjs`（CRLF 规范化）、`scripts/check-csp-runtime.mjs`（需 `-f`） |
| **B** | M6 Lua 后续（并行会话产出，**非本次升级**） | `README.md`、`README.en.md`、`electron/services/config-path.ts`、`electron/services/lua-script-store.ts`、`lang/{en,zh-CN,zh-TW}.ts`、`shared/types.ts`、`src/components/LuaScriptDialog.tsx`、`tests/unit/luaScriptStore.spec.ts`、`electron/main.ts`（**仅 `scriptsDir` 部分**） |
| **C** | 项目底座文档（7 份未跟踪） | `docs/architecture.md`、`development-pitfalls.md`、`cultui-components.md`、`conventions.md`、`roadmap.md`、`electron-45-upgrade.md`、`csp-fix-plan.md` |

### 关键难点：`electron/main.ts` 按 hunk 拆分

同一文件同时含 A（CSP 短路 + 注释改写）与 B（`scriptsDir` 导入、启动时 `scriptsDir()` 初始化）。
`git add -p` 是交互命令，按会话规则禁用；改用非交互补丁：

1. `git diff -- electron/main.ts > /tmp/main.patch`，复制一份只保留 A 的两个 hunk；
2. `git apply --check --cached /tmp/main-A.patch` 预演通过后再 `git apply --cached`；
3. 核对 `git diff --cached` 只含目标 hunk，然后提交 A；
4. 批次 B 处理时再 `git add electron/main.ts` 收走剩余改动。

### 提交顺序与消息草案

1. **A**：`build(electron): 升级至 45.2.2 并修复 file:// CSP 回归` —— 按「一轮改动一次提交」合成一个 commit；
   前置是阶段 2 打包与第 4 节 6 项验证全部通过。
2. **B**：建议由并行会话自行提交，避免我代写 M6 的 commit message；若交给我，需用户明确归属确认，
   且提交前重新 `git status` 核对（该批仍在实时变化）。
3. **C**：`docs: 新增架构/坑位/组件库/规范底座文档与升级路线图`。

### 边界

- 提交 ≠ 推送；gitee `master` 与 GitHub `main` 两个远端需分别授权。
- `site/`、`.github/workflows/site.yml` 与站点脚本不在本预案范围（用户明确「先不要动官网」）。
- 未跑全量测试、未改产品版本号、未打标签。
