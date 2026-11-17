# Keyper 开发坑位速查

> 面向后续开发与 AI 会话的内部文档，只记录「不看就会踩」的约束和已定决策，
> 不重复 README 的功能介绍。整理于 2026-11-04，事实来源见文末。
>
> **本文刻意不写版本号、脚本清单和目录树** —— 那些会漂移，用时以 `package.json`、
> 真实目录与 `git log` 为准。发版时同步 README 的规则见 `readme-doc-hygiene` 一节。

## 0. 先分清项目与记忆来源

| 名称 | 阶段 | 是否适用 |
| --- | --- | --- |
| RedisDesktop | Vue 3，0.0.x～0.2.5，2026-10-27 之前 | 历史；日志里的 `.vue` / `App.vue` / `ValueViewer.vue` 路径**已失效** |
| RedisDocter → Keyper | React 19 + Electron，移植式重写，1.0.x | **本文对象**；仓库 `E:\MyProject\RedisDocter` |
| antyman | antd v6 / Umi Max 后台 | 不适用；「`shape="round"` + 图标」等规范属于它，别套到 Keyper |

两套记忆目录不要混写：`~/.qoder-cn/**/memory` 是 Qoder 侧，`E:\MyProject\.workbuddy\memory` 是 WorkBuddy 侧。

## 1. 授权与改动边界（优先级最高）

1. **四条交付闸门**：用户当轮没明确指令，就不做全量测试、不改版本号、不打包发布、不擅自 commit/push。兜底准则：拿不准就停下来问。
2. **「提交」≠「推送」**，且都 ≠ 升版本 / 全量测试 / 打包。「推送 git」只代表推送当前改动；裸的「推送」先确认范围（哪个远端、哪几个仓）。
3. **单独动作按字面执行**：「合并分支」= 提交已验收改动并 `--no-ff` 合回 master，不推送不升版本；「打包 exe」= 只本地打包，不 bump、不打标签。
4. **UI 开放题先出多方案 HTML 预览**，用户选定后才动真实代码；条目式小改（去掉某行、加个图标）直接实现，不要出方案。
5. **架构 / 新模块 / 重构（含「提取公共函数」）先给带 D1…Dn 决策点的方案、零实现代码**；确认后下一份交付是**接口契约清单**（通道名、类型、存储、mock、i18n 键、限值），不是直接开写。
6. **最小爆炸半径**：点名组件是硬边界，状态/交互/样式都留在被点名处，不新建组件、不改 store、不顺手重构邻居；边界外的发现只报不改。指错位置时先完整回滚上一处，再只改点名的位置。
7. **每轮以文字结论收尾**（实测数据 + 未提交说明）。用户把同一指令原样重发，多半是上一轮停在测试输出上没回报。

## 2. 本机工具链

| 目标 | 正确姿势 | 会踩的坑 |
| --- | --- | --- |
| `npm` / `npx` | 不在 Git Bash PATH；用 Qianwen 自带 `node.exe` 绝对路径 | 直接调用报 `command not found`，不要据此声称无法验证 |
| typecheck / i18n / vite | Qianwen node 跑 `node_modules/typescript/bin/tsc`、`scripts/i18n-check.mjs`、`node_modules/vite/bin/vite.js` | **vite 不能用 Electron as Node**：`vite.config.ts` 以 CJS require ESM 包会 `ERR_REQUIRE_ESM` |
| 单测 | `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run <spec>` | Qianwen node 的 agent_host 兼容模式会拒绝 `--conditions` |
| Electron 开发窗 | 同一条命令里 `unset ELECTRON_RUN_AS_NODE; npm run dev` | Qoder Desktop 泄漏 `ELECTRON_RUN_AS_NODE=1`，主进程以纯 Node 运行、`app` 为 undefined 直接崩；`env -u` 在本 shell 是坏的，会静默吞掉整条命令 |
| 已保存密码 | 用**默认 userData**，不要加 `--user-data-dir` | safeStorage / DPAPI 密钥绑定目录，换 profile 后所有密文解不开 |
| Web 预览 | `vite --mode web`（Mock 数据，可放心自测） | 直接 `vite` 会走 electron 插件并崩；5173/5174 被占用时顺延端口属正常 |
| 打包版调试 | `Keyper.exe --rd-debug` | 不能叫 `--debug`（Chromium 保留开关） |

## 3. 验证口径与探针

- **默认闸口**：typecheck 两个工程 + `i18n:check` + 被改动目标的单测；UI 改动再补 `dev:web` 的 DOM / 计算样式 / 控制台证据。**不跑全量套件**，除非用户当轮点名。
- **一律不操作截图**：视觉核对走 HTML/DOM 结构 dump、class/id 差异、CSS 层叠推导、结构化探针；需要几何数值时输出文本。
- **排查前先确认用户跑的是哪个产物**：解包实际在用的 `app.asar` 对照源码，否则会一直「复现不出来」。
- CDP 探针假阳性清单：
  - hover 用 `mouseover` / `mouseout`（`mouseenter/leave` 不冒泡，React 合成事件收不到）；
  - `element.blur()` 在 headless 里不派发事件，需手动 `dispatchEvent(new FocusEvent('blur'))`；
  - 合成 `input` 改 React 受控输入，先清 `_valueTracker` 再 setter + dispatch；
  - 复用 `user-data-dir` 会让 localStorage 残留污染断言，每次用新 profile；
  - 树形里 `.node-row` 多半是目录，断言要打叶子节点；
  - 远程 Redis 有 RTT，等类型徽标变化**且** loading 消失，固定 sleep 必然偶发失败；
  - `<Activity>` 保活会在 DOM 里留隐藏实例，查询先按 `offsetParent !== null` 过滤。
- **批量改模板禁用正则/切片**：历史事故包括吞掉整段方案、删掉 JSX 300 行、删掉 `package.json` 的 `scripts`/`devDependencies`。要么用 AST，要么精确锚点 + 立即编译验证；改结构化配置后必须 JSON 解析校验字段完整性。
- 交付级探针按「产物级 + 源码级」双查：嵌套双前缀 `.s-x .s-x.`、无前缀同名选择器冲突、`.s-x /*` 粘连形态、「文件里存在」≠「根元素上存在」。

## 4. React 移植遗留的系统性陷阱

这些缺陷**构建和 typecheck 都不报错**，是本项目最贵的一类坑。

| 陷阱 | 正确做法 |
| --- | --- |
| Vue scoped 样式平铺进一份全局 CSS，同名类静默覆盖（`.dialog` 有 13 处定义） | 每段组件 CSS 加 `.s-<组件名>` 作用域，且选择器**双命中** `.s-x.sel, .s-x .sel`；portal 到 body 的浮层要手工补作用域类 |
| 裸 `/* */` 写在 JSX 里 | 会被当文本节点渲染，图标位置显示源码字符串；特征指纹 `*/}/*`，全库扫描清零 |
| `.s-x /* 注释 */` 后紧跟选择器 | esbuild 会把残留前缀和下一条拼成错误后代形态；注释独立成行 + 补全前缀 |
| `v-show` → 裸 `hidden` 属性 | UA 的 `[hidden]{display:none}` 输给作者样式 `display:flex`，表现为多标签工作区并排；必须内联 `style={hidden ? {display:'none'} : undefined}` |
| portal / Teleport 浮层跨标签残留 | `display:none` 管不到挂到 body 的节点；凡是 portal 到 body 的 UI 都要订阅「标签失焦」信号并关闭（`useTabBlur`） |
| Vue 单例响应式模块搬到 React | **读 store 的组件必须订阅**；`AppTooltip` 曾漏 `useObservable`，导致 tooltip 全失效 |
| 单例 store 用 `Object.is` 判等 | 同值写入不 emit；显示类状态要带递增 `seq` 保证可观察 |
| `<Activity>` 隐藏→再显示 | 会重放 effect，新增 effect 必须幂等（否则清掉编辑草稿与已加载的字段 TTL） |
| 按路径字符串存 UI 状态 | 不同连接/库的目录名同形会串台；切换数据源时先清空再按新数据集重建 |
| `reactive` / Proxy 传 IPC | 结构化克隆对 Proxy 抛 `DataCloneError`；在 **preload 的 `invoke()`** 里做 `toPlain`（JSON 往返），别在各调用点 `toRaw`，也不要用 Proxy 包 `contextBridge` 暴露的对象 |
| 凭据加密 | safeStorage 密钥是 **userData 目录级**，不是账户级；已改为应用级 AES-256-GCM + 配置目录 `keys.bin`（DPAPI 保护），格式 `enc2:`（iv12‖tag16‖ciphertext），旧 `enc:` 解密成功后就地迁移 |

## 5. 产品定案（不要重新提案，也不要擅自改回去）

| 主题 | 定案 |
| --- | --- |
| 两引擎对等 | Memcached 逐项对齐 Redis：破坏性操作走 `askConfirm` 同一结构、删除图标、TTL、行高/悬停/选中态、右键菜单、值区头部与工具条；**只能补齐，不得删减内容** |
| 计数位置 | 键栏「可见 / 总数」放筛选框右侧 `trailing` 槽，纯文字 `.counter mono`，不要胶囊、不要挪到标题旁 |
| 按钮形状 | 胶囊 `999px`，全局白名单在 `src/styles/main.css`；**新增按钮类必须同步加入白名单**。豁免：页签、抽屉把手、表单控件、引擎选择卡。注意这是纯 CSS 规范，不是 antd 的 `shape="round"` |
| 按钮图标 | 按钮内文字前一律加项目 SVG 图标、`currentColor`、不进 `align-items: baseline` 容器、svg 给 `flex: 0 0 auto; max-width: none`。收藏视图等工具条按用户 2026-11-04 口径可用**纯图标 + tooltip、不放文字** |
| hover / 选中 | 一律 `--lift-shadow` 分层双影（`0 1px 1px` + `0 2px 3px -1px`），`transition: box-shadow .16s ease`，不做位移缩放；**图标按钮最容易漏** |
| tooltip | 禁用原生 `title`，一律 `tipProps`；图标-only、单字母缩写、指标口径必须补提示；文案三语言同步。`PromptDialog` / `DialogShell` 的 `title` 是**组件 prop**，不要误改 |
| i18n | `lang/en.ts` 唯一来源，语义 key `namespace.camelCase`，禁止中文 msgid；`i18n:check` 会把**未被源码引用的键判失败**，文案必须随首个使用它的 UI 同批落地；zh-TW 用既有术语表（字串/清單/雜湊/串流/連線/設定…） |
| 值区底部书签 | 标签**按连接隔离**（切走保存、切回恢复、切库清空）；详情标签固定第一且不可关闭；方案 05 悬停书签；统计移到悬停卡；长键名中间省略并保留可见 `...`；保活走隐藏而非卸载，筛选/排序/草稿/列宽/滚动位置不丢 |
| 收藏入口 | 并入「树形 \| 平铺 \| 收藏」分段控件，**不另设独立星标入口**；统计进底部状态栏；状态型星标放行尾可点，未激活空心、激活实心高亮 |
| 值格式 / CLI 面板 | 检测到的可解码格式只在底部状态栏替换左侧文案，不做工具栏按钮；解码视图禁止编辑；菜单每项图标必须不同；搜索框前不加标题或装饰 |
| 顶部指标卡 | 方案 09 无框轻排版，不要加回边框/底色 |
| 引擎标识 | 方案 05：连接名称行前置真实引擎图形，地址行不放字母角标，不包实色胶囊 |
| 品牌 | 只有主页 Logo 与顶栏图标保留层叠投影 + 悬停上浮；项目名纯文字、不加粗（像素字体合成加粗会糊）；皮肤自适应图标改造暂缓 |
| 主页卡片 | 卡面跟随皮肤（`--card-face-bg`，覆盖规则必须在 `@layer` 之外，否则被 Tailwind utilities 压过）；九宫格与信息卡默认透明、浅色虚线、hover 用全局 `--bg-hover` |
| 连接能力 | 哨兵 / 集群**明确不做**；导入导出已实现，旧方案里的待拍板项作废 |
| 新缓存引擎 | 先做「Redis 服务端型号识别」（Valkey / Dragonfly / Garnet / Kvrocks / Pika / Tair），**不新增 `CacheEngine` 类型**；Aerospike 是唯一独立新引擎候选 |
| `design/` | 已停止跟踪并加入 `.gitignore`；本地文件仍在，别再 `git add` |

## 6. 发版链路（踩错不可逆）

- 远端：`origin` = gitee / `master`，`github` = `https://github.com/qq281376065/keyper.git` / **`main`**。本地 `master` 与远端分支名不同，裸 `git push` 会失败，用 `git push github HEAD:main`；标签单独推。
- ⛔ **标签推上去后绝不能再动**（删除 / 强推 / 移到别的提交）。GitHub 按「标签被删」处理，把绑定的 Release **降级成草稿**：未认证请求对 `/releases`、`/releases/tags/<tag>`、`releases/download/<tag>/<file>` 全部 404，`/releases/latest` 回退到上一版；而带 `GITHUB_TOKEN` 的 CI 照样看见它、继续追加资产 → 表现为「流水线全绿，只有下载校验失败」。要动标签只能在**新版本号**上动。
- 重复 Release 的成因：electron-builder 为每个待上传文件各起一个 publisher，并发「查 Release，没有就建」；`releases/download/<tag>/<file>` 只解析到 id 较小的那份。发布统一交给 CI，不要本地 `dist:win:publish`。
- 发版说明的**唯一作者是附注标签正文**（`git tag -a`，正文首行是标签名）。electron-builder 两处基准目录不同，同一份文案要落 `release-notes.md`（GitHub Release 正文）与 `build/release-notes.md`（`latest.yml` 的 `releaseNotes`，客户端「检查更新」面板读它）；换版本务必重新生成。
- 同版本重打 / 旧目录被占用 → `npm run dist:win:alt`（输出 `<ver>-final`），避开 `app.asar` 文件锁；`dist:win` 在残留目录存在时容易撞锁。
- 发版前核对 `package-lock.json` 根 `version` 与 `package.json` 一致；`npm version` 会同时修正两处。
- NSIS：`installer.nsh` 编译两趟，只在安装器用的 `Var`/`Function` 必须包 `!ifndef BUILD_UNINSTALLER`；**任何 NSIS warning 都会被 electron-builder 当错误**；PATH 写入用 `WriteRegExpandStr` 且按分号边界判重。
- Windows 安装包**未签名**，360 会拦 `ffmpeg.dll` 等 Electron DLL；合法路径是 OV/EV 证书 + 360 开放平台报备，不要建议关闭/绕过安全软件。
- Linux-only 失败（例：Memcached 文本协议把半截响应当完整结果，Windows 回环会合并 TCP 段）用 `keyper-repro` 容器复现；本机没有 admin 令牌和 `gh`，只能读 `/check-runs` 注解，未认证 API 配额 60/h。

## 7. 当前进度与推进节奏

六项扩展（TTL 倒计时 / 键收藏 / 值查看器增强 / CLI 增强 / Stream 深化 / Lua 运行器）
**M0–M6 已全部提交**（M5 = `f8a88b4`，M6 = `75ccd3c`）。下一步 **M7 全量回归（M5/M6）、
全量测试、打包自检、发布说明**，逐项清单以 Qoder 记忆
`E--MyProject/memory/redisdocker-feature-expansion-m0.md` 为准。
D1–D10 决策已冻结，不要重新征求。注意：M7 里的「全量测试」仍受交付闸门约束，
**必须由用户当轮明确点名**才可执行。

节奏固定：**先方案 / 接口契约 → 实现 → 验证 → 等明确指令才提交**，一轮一次提交；用户按「先提交当前阶段，再开始下一里程碑」推进。进度以 `git log` 为准，本表可能滞后。

## 记忆来源

- `C:\Users\admin\.qoder-cn\projects\E--MyProject-RedisDocter\memory\`：项目决策与 UI 约定（`release-and-push-workflow`、`feedback-*`、`value-tabs-scheme05`、`i18n-semantic-keys`、`react19-react-compiler`、`project-*`、`reference-*`）
- `C:\Users\admin\.qoder-cn\memory\`：跨项目协作方式与红线（`feedback-ui-iteration-style`、`feedback-verification-scope`、`feedback-design-plan-before-coding`、`feedback-credential-safety`、`reference-local-node-runtime`）
- `C:\Users\admin\.qoder-cn\projects\E--MyProject\memory\`：移植期事故日志（2026-10-16 ～ 10-28）与 `redisdocker-feature-expansion-m0`
- `C:\Users\admin\.workbuddy\user-…\MEMORY.md`：用户级长期红线（语言、截图、交付闸门、断言粒度）
