# CSP 残留问题修复方案（Electron 45 升级回归）

> **状态：已按 D1–D5 推荐项实施并验证通过（2026-11-04）。**
> 实施只改 `electron/main.ts` 的 `applyContentSecurityPolicy()`；逐项验证结论见文末「附录 · 实施与验证记录」。
> 基准：`feat/electron-45-upgrade` 分支、Electron 45.2.2、2026-11-04 的 CDP 只读探针结果。
> 遵守 `docs/conventions.md` 基线：大改先方案、UI 核对不截图、验证只用 DOM / 计算样式 / 控制台文本证据。
> 关联：`docs/electron-45-upgrade.md` 附录 B（发现过程）、`docs/roadmap.md` 第 1.3 条（CSP 双通道单一来源）。

## 0. 结论先行

两项残留中，**第一项是已坐实的升级回归**：Electron 45 / Chromium 156 对 `file://` 主文档
也会触发 `onHeadersReceived`，于是项目注入的**响应头 CSP**（`script-src 'self'`，无 hash）
与 `index.html` 的 **meta CSP**（带正确 hash）叠加取最严，首帧主题脚本被拦。
`electron/main.ts:253-257` 的注释「`onHeadersReceived` 不会对 `file://` 生效」是 Electron 33 时代的
实测结论，**在 45 下已失效**。

第二项（`style-src` 拦内联样式）**未稳定复现**：一次探针出现 4 条、另一次 0 条，
且 DOM 里 `styleTags=0 / styleAttrs=53`（CSSOM 赋值，通常不受 CSP 约束）。
建议列为观察项，不纳入本次硬修，由 D2 决定。

当前影响面**有限但真实**：首帧主题脚本被拦 → 亮暗切换闪烁；React 启动后仍会应用主题，
所以最终 `data-theme`、`--accent`、`window.redisApi`、页面渲染全部正常。
安全性是「更严」而非「更松」，不存在降级。

## 1. 证据（CDP 只读探针，不截图）

| 项 | 实测值 |
| --- | --- |
| `Network.responseReceived` 主文档 | `file:///E:/MyProject/RedisDocter/dist/index.html`，status 200 |
| 该响应的 `Content-Security-Policy` 头 | `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'`（**无 hash**） |
| `index.html` 的 meta CSP | `script-src 'self' 'sha256-duieBjFDc0BF0OuaVKTeTRRVJ7um0TpmK9X9RaugcaM='; …`（**有 hash**） |
| 浏览器报错要求的 hash | `sha256-duieBjFDc0BF0OuaVKTeTRRVJ7um0TpmK9X9RaugcaM=` —— **与 meta 完全一致** |
| 由「要求 hash == meta hash」可推出 | 拦脚本的**不是 meta**，而是另一份 CSP（即响应头）；两份并存取交集 |
| 相关代码 | `electron/main.ts:103` 的 `CSP_PROD`（无 hash 硬编码）、`scripts/csp-hash.mjs:34` 的 `CSP_DIRECTIVES`（两处手工同步） |
| 旧结论 | `electron/main.ts:253-257` 注释明确写「生产走 `file://`，`onHeadersReceived` 不会生效」，33 时代成立 |
| 内联样式 | 第二次探针 4 条 `Applying inline style violates 'style-src 'self'`（来源 `dist/assets/index-*.js:151`）；第三次探针 0 条；`styleTags=0`、`styleAttrs=53` |
| 已修的关联缺陷 | `csp-hash.mjs` 的 CRLF→LF 规范化（详见升级方案附录 A），`csp:check` exit 0 |

## 2. 三个修法对比

| 方案 | 做法 | 收益 | 代价 / 风险 |
| --- | --- | --- | --- |
| **A（推荐）跳过 `file://` 响应头注入** | 在 `applyContentSecurityPolicy()` 回调里，遇到 `details.url` 为 `file:` 时原样 `callback`，不写 CSP 头；`file://` 只由 meta CSP 约束，`http://` 开发态仍走响应头 | 一处改动、回归 33 时代语义；meta CSP 已含完整指令与正确 hash，安全性不降；不引入新的同步点 | 依赖「meta 在需要约束的资源之前」这一前提；需确认不做 head 重排 |
| **B 给 `CSP_PROD` 同步 hash** | 让主进程的响应头也带上与 meta 相同的 `sha256-…` | 不依赖「file:// 是否触发」的行为差异，双通道都放行 | hash 随 `index.html` 内容变化，硬编码必然漂移；要把构建期 hash 传进主进程（构建注入或运行时读文件），把两处硬编码技术债变成三处；改动面明显更大 |
| **C 外置首帧主题脚本** | 把 `index.html` 的内联脚本改成 `<script src="./theme.js">`，由 `script-src 'self'` 放行 | 彻底不需要 hash，`csp-hash.mjs` 可简化 | 外部脚本加载有异步延迟，可能重新引入「首帧闪烁」这个原本要解决的问题；要验证 `file://` 下外部脚本被 `'self'` 放行；改动 `index.html` + 构建产物 + CSP 指令表 |

推荐 **A**：它与项目已有的「两条路径互补」设计一致，只是把新版多出来的那条路径关掉，
不新增同步点、不碰首帧时序。B 看似更「对称」，实则把 hash 漂移问题扩散到主进程。
C 收益不抵首帧闪烁风险。

## 3. 决策点（已确认：全部按推荐项）

| 编号 | 决策 | 选项与推荐 |
| --- | --- | --- |
| **D1** | 采用哪个修法 | **A（推荐）** / B / C |
| **D2** | `style-src` 内联样式 | **先不改，加一条 CDP 探针长期观察（推荐）**：错误偶发、DOM 无 `<style>` 标签，可能是 CSSOM 赋值被某次时序触发；若稳定复现再决定是否给 `style-src` 加 `unsafe-inline` 或 nonce（加 `unsafe-inline` 会削弱 XSS 防护，需单独论证） |
| **D3** | meta CSP 位置与 hash | **保持现状（推荐）**：csp-hash.mjs 把 meta 插到 `</head>` 前，而首帧脚本在 head 开头；meta 只约束其后的资源，脚本不受它管。若改用 A，hash 对脚本本身不再必要但保留无害（脚本将来若移到 meta 之后仍需要）。要调整位置需另开议题 |
| **D4** | 两处硬编码指令表是否抽单一来源 | **本次不抽（推荐）**，避免在修回归时叠加重构；列入 `docs/roadmap.md` 第 1.3 条后续处理。若选 B 则必须先做 D4，否则 hash 无法可靠同步 |
| **D5** | 验证与提交边界 | 修复后用 CDP 探针要求 **security 错误 0**、跑 `csp:check` / `typecheck` / 预检 `--strict`、目标单测；**不跑全量测试、不打包、不提交、不推送**，除非当轮另给指令 |

2026-11-04 用户回「按推荐项」：D1=A、D2=观察、D3=保持、D4=不抽、D5=按边界验证。

## 4. 落地步骤（已执行）

1. `electron/main.ts` 的 `applyContentSecurityPolicy()`：在写响应头前判断 URL scheme，
   `file:` 直接原样回调；顺带更新该函数的过期注释（把「不会生效」改为「45 起会生效，故显式跳过」）。
2. 若 D3 选择调整 meta 位置，再改 `scripts/csp-hash.mjs` 的插入点与注释（推荐保持现状）。
3. `scripts/csp-hash.mjs` 的 CRLF 规范化修复**已在上一轮落地**，无需重复改动。
4. 复跑构建与校验：`npx vite build` → `node scripts/csp-hash.mjs` → `npm run csp:check`
   → `npm run typecheck` → `node scripts/check-electron-upgrade.mjs --strict` → 目标单测。
5. 重启 Electron 45 窗口（`unset ELECTRON_RUN_AS_NODE`，带 `--remote-debugging-port`），
   用同一份 CDP 探针重载页面，要求：主文档**无 CSP 响应头**、security 错误 0、
   `theme` / `redisApi` / `--accent` / `--lift-shadow` 仍正常。
6. 全部通过后把结论回填 `docs/electron-45-upgrade.md` 附录 B 与 `docs/roadmap.md`。

## 5. 风险与回滚

- **风险 1**：跳过 `file://` 响应头后，若 meta CSP 因位置靠后而漏约束某些资源，安全性会下降。
  缓解：探针里逐项核对 meta 指令完整、外部脚本/样式/字体/图片仍被 `'self'` 约束；
  打包版再复验一次。
- **风险 2**：开发态 `http://` 仍走响应头，改动不能误伤 `CSP_DEV`（含 `unsafe-inline` / `unsafe-eval`）。
  缓解：只对 `file:` 分支短路，其余逻辑不变。
- **风险 3**：把「45 起 file:// 会触发」写进注释后，将来 Electron 再变行为可能再次失效。
  缓解：CDP 探针脚本化，纳入后续每次 Electron 升级的固定验证清单。
- **回滚**：改动集中在 `main.ts` 一个小函数；`git diff` 可直接还原，分支零提交，
  不影响任何已推送内容。

## 6. 与其它待办的关系

- 本方案**只解决验证清单第 3 项（CSP 双通道）**，不解打包失败（宿主 safe-delete shim）
  与 `style-src` 偶发错误。
- 打包验证仍需用户在普通终端执行 `npm run dist:win:alt`，之后再做 NSIS 安装启动、
  `app.asar` 解包、旧 `enc2:` 密文真连、自动更新直链、9 套皮肤逐套 DOM 回归。
- `docs/electron-45-upgrade.md` 附录 B 的验证结论已同步改为「通过」（2026-11-04）。

---

## 附录 · 实施与验证记录（2026-11-04）

### 实际改动（1 个文件）

`electron/main.ts` → `applyContentSecurityPolicy()`：

- 注释改写：把「`onHeadersReceived` 不会对 `file://` 生效」的 33 时代结论，换成
  「45 / Chromium 156 起会触发，故显式跳过」，并写明叠加取最严会拦首帧主题脚本。
- 函数体：写响应头前判断 `details.url.startsWith('file:')`，命中即
  `callback({ responseHeaders })` 原样返回（保留其它响应头），不写 CSP 头；
  `http://` 分支与 `CSP_DEV` 逻辑完全不变。

**未动**：`CSP_PROD` / `CSP_DEV` 指令表、`index.html` 的 meta 位置与 hash、
`scripts/csp-hash.mjs`（其 CRLF 规范化修复已在上一轮落地）。

### 验证结果（全绿）

| 项 | 命令 / 探针 | 结果 |
| --- | --- | --- |
| 主进程产物含新逻辑 | 读 `dist-electron/main.js` | `startsWith("file:")` 存在 ✓ |
| 构建 | `npx vite build` | exit 0 |
| CSP 注入与静态校验 | `node scripts/csp-hash.mjs` → `npm run csp:check` | exit 0，meta hash `sha256-duieBj…` |
| 类型检查 | `npm run typecheck`（web + node 两工程） | exit 0，零错误 |
| 升级预检 | `node scripts/check-electron-upgrade.mjs --strict` | exit 0，硬阻断 0 |
| 目标单测（非全量） | `vitest run credentialCrypto + connectionTransfer` | 29 / 29 |
| 真机运行时 | Electron 45.2.2 + 生产 `file://` 产物，CDP 两轮 reload | 见下 |

**CDP 反证（`scripts/check-csp-runtime.mjs`，只读、不截图）**：

| 判据 | 第 1 轮 | 第 2 轮 |
| --- | --- | --- |
| 主文档 CSP 响应头 | `null` | `null` |
| 控制台 error 总数 | 0 | 0 |
| 其中 CSP 相关 | 0 | 0 |
| 其中 style-src（D2 观察） | 0 | 0 |

DOM / 运行时：`title=Keyper`、`readyState=complete`、`.s-app` 存在、`data-theme=light`、
`html[style]` 含 `color-scheme: light`（**首帧主题脚本确实执行**）、`redisApi` 13 组（含 `luaScripts`）、
`--accent=#d0342c`、`--lift-shadow` 双层影值正确、meta 11 条指令完整且含正确 hash、
外部脚本与样式均为相对 `'self'` 资源。

### D2 观察结论

两轮均 0 条 `style-src` 错误，`styleTags=0 / styleAttrs=56`（CSSOM 赋值）。
偶发项未复现，按「先不改、长期观察」结案；探针已脚本化到
`scripts/check-csp-runtime.mjs`（`scripts/*` 被 `.gitignore` 忽略，要入库需 `git add -f`），
纳入后续每次 Electron 升级的固定验证清单。若将来稳定复现，再单独论证是否放宽 `style-src`。

### 边界

未打包、未提交、未推送、未打标签、未改产品版本号、未跑全量测试。
打包仍需在不受宿主 `safe-delete` shim 影响的普通终端执行 `npm run dist:win:alt`，
之后补 NSIS 安装启动、`app.asar` 解包、旧 `enc2:` 密文真连、自动更新直链、
9 套皮肤 DOM 回归、`--rd-debug`。分支 `feat/electron-45-upgrade` 仍零提交，
`git diff electron/main.ts` 可直接回滚本次改动。
