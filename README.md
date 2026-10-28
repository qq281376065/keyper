# RedisDocter

基于 **TypeScript + Electron + React 18 + electron-builder** 的跨平台 Redis 桌面管理工具。

> 本项目是 RedisDesktop（Vue 3 版）的 **React 移植版**：功能与界面完全对齐，
> 仅替换渲染层技术栈；主进程、preload、IPC、shared 类型契约、打包配置均原样复用。

当前版本：`1.0.0`（多标签工作区：每个连接一个标签、关标签即断开、右键菜单/溢出滚动/更多页签下拉；连接页签胶囊样式；SSH 多级跳板与连接保活；值区四页签——Redis 信息详情/慢查询日志/键内存分析/Pub/Sub 订阅；批量 TTL/重命名；全库搜索下沉主进程 + 平铺虚拟滚动；键搜索历史自动补全——按连接与库隔离、LRU 30 条、配置文件持久化、幽灵后缀 + 下拉候选双态交互；树形深层目录右键批量删除；string 双击编辑 + 工具栏编辑按钮；批量删除两键以上走值区面板；极光皮肤——蓝紫双色渐变主按钮 + 更大圆角的亮色系皮肤；连接凭据失效黄条；string 值实底行号槽——对齐插件 gutter 的实底竖带 + 右分隔线、底色随皮肤派生且与内容区不同色；安装器开始菜单快捷方式勾选页；错误落盘（渲染层/主进程异常写 logs/errors-yyyymmdd.log，带堆栈与运行时信息、5 秒去重防洪水）；连接列表批量删除（≥3 个才出现入口）；弹窗关闭纪律（普通弹窗禁点遮罩关闭，防误触丢草稿）；数字输入 type=number 炸雷防线；六类型新增入口对称（补 hash 新增字段与 stream 追加条目）；主页改版为功能导览九宫格；vitest 单元测试）

---

## 目录结构（渲染层）

| 路径 | 作用 |
| --- | --- |
| `src/store/reactiveStore.ts` | 极简响应式 store（Proxy + 版本号），与 Vue `reactive` 语义等价 |
| `src/store/session.ts` | 单标签会话：扫描/选中/值更新的竞态令牌、本地增删改、批量任务 |
| `src/store/global.ts` | 连接管理、多标签、快照恢复 |
| `src/store/useRedis.ts` | 语境包装：标签树内用 Context，标签外用激活会话代理 |
| `src/hooks/` | 设置、主题、搜索历史、弹窗拖拽、六个值类型编辑器 |
| `src/components/` | 35 个界面组件（`.tsx`）+ `components.css`（原 scoped 样式平移） |

---

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 主进程 | Electron 33 + TypeScript | 窗口管理、IPC、Redis 连接池 |
| 渲染进程 | **React 18 + Vite 6** | 界面与交互；状态层见 `src/store/` |
| 通信 | contextBridge + ipcRenderer.invoke | 上下文隔离，渲染进程不接触 Node |
| Redis 客户端 | ioredis 5 | 支持 TLS / ACL / 分页 SCAN |
| 打包 | electron-builder 25 | Windows NSIS / macOS DMG / Linux AppImage+deb |

---

## 目录结构

```
RedisDocter/
├── electron/                 # 主进程
│   ├── main.ts               # 应用入口：窗口、单实例、生命周期
│   ├── preload.ts            # 预加载：contextBridge 暴露 window.redisApi
│   ├── ipc/index.ts          # IPC 通道注册与统一错误包裹
│   └── services/
│       ├── connection-manager.ts   # 连接池 + 全部 Redis 命令
│       ├── ssh-tunnel.ts           # SSH 隧道（本地端口转发）
│       ├── connection-store.ts     # 连接配置持久化（safeStorage 加密密码）
│       ├── settings-store.ts       # 应用设置持久化（settings.json）
│       └── log-service.ts          # 手动操作日志（按天分片、超期清理）
├── shared/                   # 主进程与渲染进程共享的类型契约
│   ├── types.ts              # 数据模型
│   └── api.ts                # RedisDesktopApi 接口 + IPC 通道常量
├── src/                      # 渲染进程
│   ├── App.vue               # 整体布局（顶栏 / 三栏 / CLI）
│   ├── api/index.ts          # 数据入口：Electron 走 IPC，浏览器降级 Mock
│   ├── api/mock.ts           # 浏览器预览用模拟数据
│   ├── composables/
│   │   ├── useRedis.ts       # 轻量状态层（不引入 Pinia）
│   │   ├── useTheme.ts       # 主题状态、系统跟随与持久化
│   │   ├── useSettings.ts    # 全局设置：加载、保存并落到 CSS 变量
│   │   ├── useDialogDrag.ts  # 弹窗拖动（12 个弹窗共用）
│   │   └── useTooltip.ts     # 全局 tooltip 状态（配合 v-tip 指令）
│   ├── directives/
│   │   └── tip.ts            # v-tip：统一提示指令，替代原生 title
│   ├── utils/
│   │   ├── keyTree.ts        # 键名 → 树结构（折叠用）
│   │   ├── redisCapability.ts # 服务端版本解析与能力探测（如 7.4+ 字段级 TTL）
│   │   ├── log.ts            # 操作日志分级（danger / change / normal）
│   │   ├── format.ts         # TTL / 字节 / JSON 格式化
│   │   └── clipboard.ts      # 剪贴板写入（含降级方案）
│   ├── components/
│   │   ├── ConnectionSidebar.vue   # 左侧连接列表
│   │   ├── ConnectionActions.vue   # 连接项操作菜单
│   │   ├── KeyBrowser.vue          # 中间键浏览（SCAN + 筛选 + 树形/平铺 + 分页）
│   │   ├── KeyTreeNode.vue         # 键树递归节点（可折叠）
│   │   ├── ValueViewer.vue         # 右侧值查看（只读 + JSON 美化 + 容器搜索）
│   │   ├── ValueActions.vue        # 值操作菜单（编辑 / 重命名 / TTL / 复制 / 删除）
│   │   ├── EditValueDialog.vue     # 编辑值弹窗（按类型呈现表单）
│   │   ├── EditHashFieldDialog.vue  # 修改 hash 单字段（field / value）
│   │   ├── EditHashFieldTtlDialog.vue # 设置 hash 字段级 TTL（7.4+）
│   │   ├── VersionInfoDialog.vue    # 版本信息与能力探测
│   │   ├── PromptDialog.vue        # 通用单值输入弹窗（重命名 / TTL 等）
│   │   ├── CliConsole.vue          # 底部命令控制台
│   │   ├── ConnectionDialog.vue    # 新建 / 编辑连接弹窗
│   │   ├── CreateKeyDialog.vue     # 新建键弹窗
│   │   ├── SettingsDialog.vue      # 全局设置
│   │   ├── LogPanel.vue            # 操作日志抽屉（日期 / 连接 / 关键字筛选）
│   │   ├── ConfirmDialog.vue       # 通用二次确认弹窗
│   │   ├── ThemeSwitch.vue         # 主题切换（跟随系统 / 亮 / 暗）
│   │   ├── AppTooltip.vue          # 全局提示渲染层（所有 v-tip 共用）
│   │   └── WelcomePanel.vue        # 无任何连接时的欢迎页
│   └── styles/main.css       # 双主题设计令牌、字号体系与全局样式
├── scripts/                  # 开发期校验脚本（键树 / tooltip / 右键菜单断言）
├── preview.cmd               # 双击启动浏览器预览（Windows）
├── vite.config.ts            # 渲染进程 + 主进程构建
└── electron-builder.yml      # 打包配置
```

---

## 常用命令

```bash
npm install          # 安装依赖（国内网络建议配镜像，见下）
npm run dev          # 开发模式：启动 Vite + Electron，支持热更新
npm run dev:web      # 纯浏览器调试渲染层：只起 Vite，不编译/不拉起 Electron
npm run preview      # 预览已构建产物（http://127.0.0.1:4173）
npm run typecheck    # 类型检查（主进程 + 渲染进程）
npm run build        # 类型检查 + 构建产物到 dist/ 与 dist-electron/
npm run check:keytree # 键树构建算法断言（7 个场景）
npm run check:tip    # 全局 tooltip 定位算法断言（8 个场景）
npm run check:keymenu # 右键菜单链路、删除确认结构、子树收集断言
npm run check:table  # 表格粘性布局（表头吸顶 / 底栏吸底）断言
npm run check:collapse # 树形折叠态生命周期（删除不重置）断言
npm run check:bulk   # 批量删除表格排序 + 按钮图标居中断言
npm run check:icons  # 按钮图标全覆盖断言（所有文字按钮都带图标）
npm run check:disconnect # 断开连接后的状态清理断言
npm run check:config # 配置持久化（便携目录 / 回退 / 字段完备）断言
npm run dist:win     # 打包 Windows 安装包
npm run dist:mac     # 打包 macOS 镜像
npm run dist:linux   # 打包 Linux 包
```

国内网络安装 Electron 二进制较慢，建议先执行：

```bash
npm config set registry https://registry.npmmirror.com
# Electron 二进制镜像（项目已在 electron-builder.yml 中配置打包期镜像）
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   # Windows
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ # macOS / Linux
```

### 打包工具链镜像

`electron-builder` 在封装 NSIS 安装器时还要额外下载 `nsis`、`nsis-resources`、
`winCodeSign` 等工具链，这些默认从 **GitHub Releases** 拉取，国内常连接超时，
表现为 `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`，且在
`%LOCALAPPDATA%\electron-builder\Cache\nsis\` 下留下一个**空目录**。

注意这与上面的 `electronDownload.mirror`（Electron 运行时二进制）是**两回事**，
且 `electron-builder.yml` **没有**对应的配置项 —— 只能通过环境变量生效。
项目已在 `package.json` 的 `config` 字段中声明，`npm run` 执行时自动注入，无需额外操作：

```json
"config": {
  "electron_builder_binaries_mirror": "https://npmmirror.com/mirrors/electron-builder-binaries/"
}
```

### 验证打包产物

在**设置了 `ELECTRON_RUN_AS_NODE=1` 的终端里**（如某些 Electron 集成环境），
打包好的 exe 会以纯 Node 模式运行、不创建窗口，表现为「启动即退出且无报错」——
`exe --version` 会输出 Node 的版本号而非 Electron 版本。验证时先清掉这两个变量：

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./RedisDocter.exe
```

需要定位启动问题时，可开启主进程诊断日志：

```bash
REDISDOCTER_DEBUG_LOG=/tmp/rd.log ./RedisDocter.exe
# 日志会记录：module loaded → requestSingleInstanceLock 结果 → app ready → 窗口创建
```

---

## 安装器（NSIS 定制）

安装包由 `build/installer.nsh` 与 `build/installer-env.nsh` 定制，两者分工明确：

| 文件 | 职责 |
| --- | --- |
| `installer-env.nsh` | 环境检查页：检测逻辑、nsDialogs 界面 |
| `installer.nsh` | 挂载钩子、写入/清理 PATH |
| `make-icon.py` | 生成 `build/icon.ico`（16/24/32/48/64/128/256 七个尺寸） |

### 环境检查做了什么

本应用是 Electron 应用，运行时（Node / Chromium / V8）随包携带，ioredis 与 ssh2 也都是
随包的库，主进程**不调用任何外部程序**。因此传统意义上的「检查 VC++ / .NET / Node.js」
在这里是无效检查 —— 装一个只看不用的检查页只会增加点击，一个失败案例也拦不住。

实际检测的是会导致「装完打不开」的系统条件，安装页面位于**目录选择之后**（此时
`$INSTDIR` 已是最终值，磁盘与权限才测得准）：

| 检查项 | 判定 | 不通过时 |
| --- | --- | --- |
| Windows 版本 | 内部版本 ≥ 17763（Win10 1809） | 提示后可勾选继续 |
| 系统位数 | 必须 x64 | **硬性中止** |
| 磁盘空间 | ≥ 600 MB | 提示后可勾选继续 |
| 安装目录 | 实写探针文件验证 | 提示后可勾选继续 |

### PATH 环境变量

安装完成把安装目录写入**当前用户** PATH（`HKCU\Environment`），卸载时移除：

- 用 `WriteRegExpandStr` 写 `REG_EXPAND_SZ`，保留 `%USERPROFILE%` 一类变量不被固化
- 幂等：重复安装不会产生重复条目（实测验证）
- 卸载按分号边界逐段比对，不会把 `RedisDocter2` 误伤成 `RedisDocter`

### 踩过的坑（修改时注意）

1. **`installer.nsh` 会被编译两次**（安装器一次、卸载器一次）。只在安装器用到的
   `Var` / `Function` 必须包在 `!ifndef BUILD_UNINSTALLER` 里，`un.` 前缀函数必须包在
   `!ifdef BUILD_UNINSTALLER` 里。否则会报 `warning 6010 / 6001 / 6020`，而
   electron-builder **默认把 NSIS 警告当错误**，打包直接失败且报错信息里只有一行 `Error output:`。
2. **环境检查页用 `customPageAfterChangeDir` 钩子**，不要用 `customWelcomePage`
   （后者会替代默认欢迎页，且位置在目录页之前）。
3. 在 `-D` 之外自行 `!include "StrContains.nsh"` 会触发未引用警告，PATH 判重改用
   分号边界拼接即可。

### 重新生成图标

```bash
npm run icon   # 等价于 python scripts/make-icon.py
```

图标为「红立方体 + 白色 R」，R 用矢量笔画手绘而非字体 —— 字体字形墨迹只有字号的 66%，
缩到 16×16 时白色像素会归零，任务栏上只剩一个纯红方块。

---

## 界面预览

| 方式 | 命令 | 看到什么 | 适用场景 |
| --- | --- | --- | --- |
| 浏览器跑真组件 | 双击 `preview.cmd`（或 `npm run dev:web`）→ 打开 `http://127.0.0.1:5173` | 真实 Vue 组件，支持热更新；数据走 `src/api/mock.ts` | 日常调界面，不必等 Electron 窗口 |
| 构建产物预览 | `npm run build && npm run preview` | 生产构建产物，静态服务在 `http://127.0.0.1:4173` | 验证打包结果 |
| 完整应用 | `npm run dev` | Electron 真实窗口，IPC 与 ioredis 全链路生效 | 验证连接、命令、日志落盘、设置持久化等真实行为 |

> 浏览器模式下没有主进程，设置与日志等能力由 `src/api/mock.ts` 提供演示数据；
> 需要验证它们真实行为（日志写入配置文件目录的 `logs/`、设置持久化）时请用 `npm run dev`。
>
> **字段级 TTL 的预览方式**：演示数据含四个连接，其中「**新版演示 (7.4+)**」
> （`127.0.0.1:6381`）模拟 Redis 7.4.4，连接它即可看到 hash 的 TTL 列与修改入口；
> 其余三个连接为 7.2.4，TTL 列会隐藏并在状态栏说明原因。
> mock 中低版本连接的 `hashFieldTtls` 返回 `null`，与真实环境收到 `unknown command` 的行为一致。
>
> **界面只有 `src/` 一份实现。**
> 早期曾存在一个手写的静态原型页（`preview/index.html`，原生 HTML/JS），
> 因需要同步维护两份实现、且已出现过不一致（弹窗无法关闭的缺陷仅存在于静态页，
> 因其 `display:flex` 覆盖了 `hidden` 属性），已移除。

---

## 已实现的骨架能力

**核心链路**

- 窗口生命周期、单实例锁定、开发/生产两种加载路径
- 连接配置 CRUD 与本地持久化，**密码经 Electron `safeStorage` 加密后落盘**
- 连接池管理：connect / disconnect / test / 全量释放
- 服务端信息：版本、模式、键总数、客户端数、内存、命中率、OPS
- 键浏览：分页 `SCAN` + 模式匹配 + 前端筛选 + 多 DB 切换
- 值查看：string / hash / list / set / zset / stream 六种类型的只读展示。
  **JSON 美化只对 `string` 提供** —— 只有整块文本才谈得上缩进重排；
  hash / list / set 本质上已是结构化展示，逐项缩进会让行高参差、信息密度下降，故不提供；
  zset 的 member/score 与 stream 的固定结构更无美化空间。
  容器类型支持搜索：hash **仅按 field 匹配**；list/set/zset/stream 按内容过滤（string 为单值，不提供）
- **string 值操作栏**：位于值区上方（与右上角键级 ⋮ 菜单分工明确）——
  复制全部内容、JSON 美化开关、自动换行开关（关闭后长行横向滚动，便于比对长串）、
  导出为本地文件（主进程保存对话框）、刷新；右侧显示字符数与行数
- **hash 值表格**：首列为固定宽度（40px）的**序号列**，不参与伸缩与排序，
  序号按当前显示顺序重编（排序后仍是 1、2、3…，反映"第几行"）；
  field / value 两列可点击表头排序；底部状态栏汇总字段数、总字节与最大字段
- **hash 值操作栏**：复制（以 JSON 格式复制全部字段）、导出（JSON 文件）、刷新；
  **搜索框固定在最右侧**且**仅匹配 field**（value 往往很长，参与匹配会把结果撑得难以阅读）；
  右侧显示「命中 / 总数 字段」
- **hash 行操作栏**：每行末尾提供 复制（字段名 + 值）/ 修改 / 删除三个图标按钮（带 tooltip），
  默认半透明、悬停整行时才明显（避免干扰读数）。
  「修改」打开独立弹窗，可同时改 field 与 value；改名等价于 HDEL 旧字段 + HSET 新字段，弹窗内有提示。
  删除走 `HDEL`（新增 IPC `redis:delHashField`），带二次确认；
  最后一个字段被删除时 Redis 会连带移除该键，提示文案已说明这一点
- **hash 行右键菜单（仅复制，分两组）**：
  「字段」组 —— 复制字段名 / 复制字段值 / 复制名称与值；
  「其他格式」组 —— 复制为 HSET 命令（可粘进 redis-cli 复现）、复制为 JSON 键值对。
  菜单顶部显示字段名便于确认目标，按视口自动翻转避免溢出，Esc / 空白处 / 窗口缩放均可关闭
- **搜索框图标**：值区搜索（hash 的 field 搜索、容器类型的元素搜索）与键列表的「当前结果筛选」
  统一改为「图标 + 输入 + 清除按钮」容器结构：放大镜图标在左、聚焦时图标与边框转为强调色、
  有内容时右侧出现圆形清除按钮。**db 选择器旁的「匹配模式」输入框不加图标**（它是路径式的模式输入，非搜索语义）
- **list 值界面**：复用 hash 的表格形态，但**无 field 列与 TTL 列**（list 无字段概念），
  仅「序号 / value / 操作」三列，序号列固定 40px 不参与排序；
  value 列可按表头排序，支持搜索元素、单行选中（与 hash 同构）。
  操作栏：复制全部（按行拼接）、导出为文本、追加到末尾、刷新、自动刷新开关、搜索；
  状态栏汇总元素数 / 匹配数 / 总字节 / 最长元素下标 / 选中项
- **list 行操作**：右键菜单仅两组 —— 「复制」（**复制字段值** / LSET 命令 / JSON）、
  「位置」（在此项前插入、在此项后插入）；
  修改与删除改由**行内图标按钮**承担（复制 / 修改 / 删除），双击行也可直接修改。
  修改与插入**共用弹窗** `EditListElementDialog.vue`（`mode` 区分），二者形态一致：
  顶部 key 预览条（list 类型徽标 + 完整键名 + `#位置/总数` 或 `插入点 #N`），
  底部**状态栏**（字符数 / 行数 / 字节数；**编辑模式**额外显示改动量增减，无改动时禁用保存；
  **插入模式**显示 `插入后共 N 项`，追加时显示 `将追加为第 N 项`），
  内容为 JSON 时额外提示「合法 JSON」或「JSON 格式有误」
- **删除确认弹窗（结构化展示）**：`ConfirmDialog` 的 `ConfirmRequest` 支持
  `details`（键值对明细：标签灰色、值加亮、数据类值等宽）、
  `preview`（待操作内容独立区块，左侧强调条 + 等宽，超长标注「已截断」）、
  `warning`（风险提示，红底 + 圆形感叹号图标），三者均为可选，与原 `message` 兼容。
  **list 删除**展示键名 / 位置 / 大小 + 待删内容预览；**hash 删除字段**额外展示
  `字段数 N → N-1`，若为最后一个字段则警告「删除后整个键也会被移除」。
  以此区分「元数据」与「内容」，避免一大段同色文字里抓不到重点
- **set 值界面**：表格形态（序号 / member / 操作三列），**按你的决定保留序号、去掉排序与插入** ——
  set 无序，排序会让「第 N 项」随时变化、插入也无位置概念，两者都会误导；
  序号仅作行计数（列头 tooltip 与状态栏均注明「不代表存储顺序」）。
  操作栏：复制全部、导出、**新增成员**（替代 list 的「追加」）、刷新、自动刷新开关、搜索；
  状态栏汇总成员数 / 匹配数 / 总字节 / 最长成员。
  右键菜单只保留「复制」一组（成员内容 / SADD 命令 / JSON）—— 无序集合没有「位置」分组
- **set 成员操作**：新增 `redis:setSetMember` / `delSetMember` / `addSetMember`。
  **修改成员等价于 SREM 旧 + SADD 新**（成员本身即标识），用 pipeline 保证两步同往返；
  若新成员原本已存在，如实提示「已删除旧成员（X 原本已存在）」，避免用户以为改没生效。
  SADD 天然幂等，重复新增会提示「已存在，未重复添加」。
  编辑弹窗复用 `EditListElementDialog`，通过 `item-label` / `key-type` / `show-position`
  适配无序语义（称「成员」、不显示位置）
- **zset 值界面**：表格形态（序号 / member / score / 操作 四列）。
  **默认按 score 降序**（对应 ZREVRANGE 的排行榜视角），点 score 表头可切升降序 ——
  排序是 zset 的核心语义（它本就是按 score 有序的集合）。
  score 列**右对齐**便于比较大小，并用 zset 主题色区分；序号列即当前排名。
  操作栏：复制全部、导出、**新增成员**、刷新、自动刷新、搜索；
  状态栏汇总成员数 / 匹配数 / 总字节 / **score 区间**（体现有序语义）
- **zset 成员定位用 member 名而非下标**：zset 会随 score 变化重排，
  下标随时可能改变；member 是唯一标识，稳定可靠 —— 编辑 / 删除均按 member 定位
- **zset 成员操作**：新增 `redis:setZsetMember` / `delZsetMember` / `addZsetMember`。
  **改 score** 走 ZADD 更新语义（对已存在 member 即更新）；
  **改 member 名**走 ZREM + ZADD（pipeline 同往返），新名若已存在会如实提示「score 已更新」。
  score 必须是有限数字（Redis 原生错误信息不友好，故先校验）。
  专用弹窗 `EditZsetMemberDialog.vue`：member + score 双字段输入，
  底部状态栏实时显示 score 解析结果与成员字节数，非法 score 时禁用提交并标红
- **stream 值界面**：表格形态（序号 / entry ID / 字段 / 操作 四列），**只读**。
  stream 是追加写的消息日志 —— 改历史 entry 会破坏消费位点语义、删 entry 会造成消费缺口，
  因此只提供复制类操作，无新增 / 编辑 / 删除入口。
  序号列与操作列固定，**不提供任何列宽拖拽手柄**（只读类型无需调列宽）
- **表格底栏的「只读」标签**：五种表格类类型（hash / list / set / zset / stream）的
  表格底栏最右均显示「只读」标签，与左侧的操作提示分列两端
  （`.row-tip` 改为 `flex` + `.tip-text { flex: 1 }`）。
  语义上指**表格本身只作只读展示**，改动需走右键菜单或双击行
  （tooltip 即如此说明）；stream 因是追加写日志，tooltip 另作说明。
  string 类型不是表格形态，故不显示该标签。
  操作栏中原本的「只读」标签已移除 —— 它属于表格的属性，放在值区状态栏会与
  全局统计信息混淆
- **stream 字段不做 JSON 美化**：字段是扁平的 `key=value` 列表而非嵌套结构，
  缩进重排只会拉开行高、降低一屏内的信息密度，故原样展示（与 hash 的处理方式不同）
- **stream 字段列单行截断**：字段可能是很长的 JSON 或文本，
  若沿用 `pre-wrap` 自动换行会把单行撑到十几行高、一屏只看得到两三条消息；
  改为 `nowrap` + `ellipsis` 保持行高一致，完整内容看悬停提示或右键复制
- **stream entry ID 排序**：按「毫秒时间戳 + 序号」**分段数值比较**。
  直接字符串比较会让 `…-10` 排在 `…-9` 之前，而 Redis 的序号是按数值递增的
- **弹窗按钮图标**：底部操作栏的按钮统一在文字前加图标，由 `src/components/DialogIcon.vue` 提供。
  图标按**语义**命名（`cancel` / `save` / `close` / `check` / `test` / `copy` / `add` / `edit` / `trash`）——
  调用方关心的是"这个按钮在做什么"，形状调整时不必回头改所有调用点。
  规格 16×16 viewBox、`stroke: currentColor`（跟随按钮文字色，主/次按钮上都能自动适配）、
  描边 1.5（比表格行内图标略粗，因弹窗按钮字号更大）。
  做成组件而非各处内联：同一套图标要出现在 12 个弹窗的 25 个按钮里，
  内联会把上百行重复路径散落到各文件
- **弹窗按钮圆角**：底部操作栏按钮使用胶囊形（`border-radius: 999px`）。
  12 个弹窗统一使用 `.dialog-foot`，规则集中定义在 `src/styles/main.css`。
  **选择器必须含两个类**（`.dialog-foot button.btn`）：组件内的 `.btn` 经 Vue 编译后
  带 scoped 属性（`.btn[data-v-x]`），特异性为 `[0,2,0]`，而 `body .dialog-foot button`
  只有 `[0,1,2]` —— **类选择器的权重高于元素**，加再多的 `body`/`button`
  也换不来一个类权重，规则会被静默压过（页面无报错，只是圆角没变）。
  `ConfirmDialog` 的确认按钮用自定义类 `.confirm-btn`（不带 `.btn`），
  无法被上述规则覆盖，已在该组件内直接声明胶囊圆角。
  胶囊两端是弧线，同等的左右内边距视觉上更"紧"，故横向内边距略增补偿
- **弹窗拖动**：全部 12 个弹窗支持拖动 —— 按住**标题栏**移动窗口。
  由 `src/composables/useDialogDrag.ts` 统一提供（`dragStyle` 绑 `.dialog`、`onDragStart` 绑 `.dialog-head`）。
  设计要点：位移用 `transform` 而非 `top/left`（不触发重排，也不与 flex 居中的初始定位冲突）；
  只由标题栏触发（内容区输入框与文本选择需要正常的鼠标划过）；
  按弹窗尺寸把位移钳制在视口内（否则拖出屏幕后按钮点不到）；
  拖动时给 `body` 加 `.dialog-dragging` 锁定光标并禁用选中。
  注意 `body` 类规则必须写在 `src/styles/main.css`，组件 `<style scoped>` 会被编译成
  `body.xxx[data-v-yyy]` 而永不命中（原有 `col-resizing` 就有此缺陷，已一并修正）
- **stream entry 查看弹窗**：右键菜单首项「查看完整内容」，打开 `ViewStreamEntryDialog.vue`。
  表格里的字段是单行截断的，查看弹窗的存在意义就是**看全**，因此：
  字段解析为**键值对表格**（支持 JSON 对象与 `key=value` 两种形态），
  值列**换行不截断**（长值限高 220px 后内部滚动）；
  解析不出结构时退回原文展示（不做额外说明文案，
  单纯把内容呈现出来即可，避免在只读弹窗里堆叠解释性文字）
  字段区右上角提供**「字段明细 / JSON 明细」视图切换**，样式与主页 `KeyBrowser` 的
  「树形 / 平铺」切换完全一致（同边框、同字号、选中态用强调色填充）——
  同一套交互在不同位置呈现不同外观，会让人以为是两种不同控件；
  字段明细逐项拆开便于核对单个字段，JSON 明细给出美化缩进的完整原文便于整体复制；
  **内容不是 JSON 时切换项自动隐藏**（`key=value` 序列强行格式化只会变成被引号包裹的字符串）。
  弹窗另显示 entry ID 的**可读时间**（由毫秒时间戳换算）与位置 `#N / 总数`。
  单独成组件而非复用编辑弹窗：后者中间是可编辑 textarea，
  stream 是只读日志，给一个能改的输入框却无保存入口会造成语义矛盾
- **stream 统计**：状态栏显示 entry 数 / 匹配数 / 总字节 / **entry ID 区间**（即消息时间跨度，
  ID 过长时缩写显示，悬停看完整值）
- **切换键时关闭全部类型的行菜单**：hash / list / set / zset / stream 各有独立的菜单状态，
  统一由 `closeAllRowMenus()` 处理（Esc、窗口缩放、切换键三处均调用）——
  只关当前类型会导致切回旧类型时浮层「凭空出现」
- **列宽拖拽调整（hash / zset）**：表头列右缘有拖拽手柄（悬停时显现细线，拖动变强调色），
  按住可调整该列宽度，**双击手柄恢复默认**。仅 hash 与 zset 支持，
  且**仅会话内有效**（按要求不持久化）。
  实现要点：宽度由 CSS 变量 `--w-first` / `--w-second` 驱动栅格，
  拖拽只改一个数字，不必拼接 `grid-template-columns` 字符串；
  手柄用绝对定位贴在**表头单元格**右缘而非作为独立栅格子项，
  否则会多占一列导致表头与数据行错位；
  宽度按「起始宽度 + 总位移」计算而非逐次累加，避免亚像素偏差累积；
  范围限制 80–900px。拖拽期间给 `body` 加 `.col-resizing` 锁定全局光标并禁用文字选中
- **表头样式**：字重 600 + 次要色（`--text-secondary`），与数据行（主色 + 常规字重）形成层次。
  只加粗不提亮在深色主题下会"越粗越糊"——粗体在小字号 + 低对比度时反而降低清晰度，两者需配合
- **排序指示用 SVG 三角形**（`src/components/SortIcon.vue`），替代原来的 `⇅ / ↑ / ↓` 字符：
  字符箭头在不同字体下的粗细与基线位置不一致，`⇅` 在小字号下尤其容易糊成一团；
  三角形是纯几何形状，缩放与对齐都可控。三态为
  **未排序（上下双三角，透明度 0.28，悬停升至 0.55）** / **升序（实心上三角）** / **降序（实心下三角）**，
  用 `fill: currentColor` 跟随列头，排序激活时自动继承 `.th.on` 的强调色。
  封装成组件而非在 6 处重复三元表达式
- **操作后本地更新**：删除 / 插入 / 修改 list 元素与 hash 字段、删除 hash 字段后
  **只改动对应数据，不整表重读**。
  原因是 `refreshSelected()` 会走一遍 `selectKey` 并把 `loadingValue` 置为 true，
  界面闪出骨架屏 —— 明明只改一行却像整页重载。
  改为 `dropElementLocally()` / `insertElementLocally()` / `replaceElementLocally()` /
  `renameFieldLocally()` 直接改动 `selectedValue` 并同步 `length`，零 IPC 往返；
  同时维护关联状态（字段 TTL 缓存、最后一个元素被删时清空选中态）。
  **仍保留回读的场景**：工具栏刷新按钮（用户主动要重读）、自动刷新定时器（目的即拉最新）、
  字段 TTL 设置（TTL 由服务端计算）
- **刷新与骨架屏的语义区分**：`selectKey` 支持 `silent` 参数，区分两类读取 ——
  **切换键**走骨架屏（内容将整块替换，骨架避免布局跳变）；
  **刷新当前键**（工具栏刷新 / 自动刷新 / 弹窗保存后 / 改字段 TTL）走 `state.refreshingValue`，
  在值区叠加**半透明遮罩 + 转圈**，页面结构与可交互区域（头部、工具栏、状态栏）保持不变。
  半透明而非实心，是为了让用户看到"内容还在，只是在更新"，
  与骨架屏的"内容将替换"在语义上区分开
- **读取 Loading 动效**：点击键后右侧展示**骨架屏**（标题栏 / 工具栏 / 6 行表格占位），
  每行错开 70ms 延迟形成自上而下的流动感。用骨架而非转圈，
  是因为它保留了实际布局尺寸，数据到达时不会发生跳变
- **hash 自动刷新**：操作栏的**滑块 switch**（32×18，开启时轨道转强调色 + 滑块位移 + 呼吸点动画），
  非原生 checkbox 外观。注意全局样式 `input { background / border / padding }` 会命中该控件，
  因此原生 input 必须 `appearance: none` 并逐个覆盖上述属性（仅靠 `opacity: 0` 仍会露出默认勾选框）。
  开启后**每 5 秒**重读当前 hash（默认关闭）。
  三种情况会跳过本次刷新，避免打断操作或请求堆积：有弹窗打开（编辑 / TTL / 重命名菜单）、
  右键菜单打开（菜单锚定在具体行上）、上一次刷新尚未返回（慢连接下防堆积）。
  切换到非 hash 类型时自动关闭；组件销毁时清理定时器
- **hash 单行选中**：单击行选中（左侧强调竖条 + 底色 + 序号高亮），再次点击取消；
  右键会同步选中该行，让菜单目标与视觉高亮一致；状态栏显示当前选中的字段名。
  选中态与 hover 态区分明确 —— hover 随鼠标移走消失，选中持续保留
- **hash 字段级 TTL（Redis 7.4+）**：`HEXPIRE` / `HTTL` / `HPERSIST` 自 7.4.0 引入，
  低版本对这三个命令返回 `unknown command` 而非降级可用。
  界面**按连接的 `redis_version` 动态决定是否渲染 TTL 列**，版本未知时保守隐藏；
  TTL 列可点击直接设置（复用数字框 + 常用值 + 永久档位），状态栏在能力不可用时给出说明。
  版本判定与能力推导集中在 `src/utils/redisCapability.ts`，便于后续扩展
- **版本信息查看**：连接项操作菜单新增「版本信息…」，
  展示版本号 / 部署模式、**能力探测结论**（字段级 TTL、ACL、多线程 IO 等），
  以及按 INFO 段落分组的详细字段（Server / Clients / Memory / Persistence / Stats / Replication / CPU / Keyspace），
  支持「仅显示关键项」切换与「复制完整 INFO」
- 值编辑：不在行内直接编辑，统一通过 ⋮ 操作菜单打开独立对话框；
  写回时携带原 TTL，避免整键重建导致过期时间丢失
- 键操作：重命名、TTL 修改、删除（均经操作菜单，删除带二次确认）
- CLI 控制台：命令解析（支持引号）、结果格式化、历史记录（↑↓）。
  **高危命令防护**：`FLUSHALL` / `FLUSHDB` / `SHUTDOWN` 执行前弹出二次确认，
  且必须逐字输入命令名才能提交（不是"点一下确认"的软提示），取消后在控制台留下记录

**界面能力**

- **主题**：跟随系统 / 亮色 / 暗色，默认跟随系统；选择持久化到 `localStorage`，
  首帧由 `index.html` 内联脚本预置 `data-theme`，避免亮暗闪烁。窗口底色同样跟随系统
- **键树**：按键名分隔符（默认 `:`，可改为 `/`、`-` 等）分层折叠，
  **默认全部折叠**（此时「全部折叠」按钮呈选中态）；支持逐层展开、
  全部展开/折叠（按钮带选中态，手动逐层调整后转为「均不选中」的 custom 态），
  并可一键切回平铺视图。

  **折叠态的重置时机**：只在**数据集身份**（连接 + 库 + 匹配模式）变化时重新全折叠 ——
  这三者决定"要看哪些键"，切换后旧树形已无意义。
  而**删除 / 新建 / 重命名键只是数据增减，用户的展开-折叠状态会被完整保留**。
  判定依据刻意写成数据集身份而非"树结构是否变化"：后者会因分页追加、删除、
  筛选等任何数据变动而误判，导致用户刚展开的目录突然收起（或反之）。
  「继续扫描」（增量追加）同样保留当前展开状态。
- **新建键**：键浏览区工具栏的 ＋ 按钮打开对话框，支持 string / hash / list / set / zset，
  填写初始内容与可选 TTL；创建成功后自动展开其祖先路径并选中该键。
  容器类型要求至少一个元素（Redis 的容器键需要有元素才会真正落库）
- **连接项操作菜单**：建立/断开连接、刷新服务端指标、**版本信息**、测试连接、编辑配置、
  克隆连接、复制连接地址（`redis://…`）、删除连接
- **SSH 隧道连接**：Redis 只在内网 / 回环地址可达时，通过跳板机转发访问。
  在新建连接弹窗中勾选「通过 SSH 隧道连接」展开配置：

  | 字段 | 说明 |
  | --- | --- |
  | 跳板机地址 / 端口 | SSH 服务器，端口默认 22 |
  | SSH 用户名 | 登录跳板机的账号 |
  | 认证方式 | **密码** 或 **私钥**（可粘贴，也可从文件读入） |
  | 私钥口令 | 私钥本身加密时填写，未加密留空 |

  实现方式（`electron/services/ssh-tunnel.ts`）：建立 SSH 连接后，在本机
  `127.0.0.1` 上监听一个由系统分配的空闲端口，每来一条本地连接就通过
  `forwardOut` 打开通往 `目标:端口` 的 direct-tcpip 通道并双向 pipe。
  ioredis 只连本机端口，**上层逻辑完全不感知 SSH 的存在**。

  - 为什么不在 `forwardOut` 单条通道上直接交给 ioredis：ioredis 会自行发起
    连接与重连，无法接收一个已建立的 socket；本地监听端口是唯一能保持
    "普通 TCP" 语义的做法。
  - 隧道按连接 id 缓存：`test` 与 `connect` 对同一配置只建一条，避免重复
    SSH 握手与跳板机上的频率限制。
  - **生命周期**：连接建立时开启，断开连接 / 连接失败 / 探活结束即关闭，
    不在跳板机上留下闲置会话。
  - **凭据安全**：SSH 登录密码与私钥口令与 Redis 密码同等对待，经
    `safeStorage` 加密后落盘（私钥正文不加密 —— 用户从本地文件粘贴，
    磁盘上本就存在，加密只会拖慢读写）。
  - 界面在连接项地址行显示 `SSH` 徽标（悬停可见跳板机地址），
    避免连不通时分不清「直连地址」与「跳板机地址」。
- **CLI 控制台默认收起**：命令行是低频能力，常驻展开会持续占用底部约 1/4
  垂直空间。默认只保留一行入口（标题 + 当前连接提示），点击即展开；
  不持久化折叠状态，每次启动都回到收起态。
- **服务端概览卡片**：连接成功但尚未选中任何键时，右侧展示三张等宽卡片 ——
  **服务器**（Redis 版本 / 运行模式 / 进程 ID）、**内存**（已用内存 / Lua 占用 / 每秒操作数）、
  **状态**（客户端连接 / 键总数 / 命中率），每张卡标题前带语义图标。
  顶部显示「连接名 + host:port + SSH 徽标」与**唯一的刷新按钮**，
  点击同时刷新概览与下方详情（两块数据同源于一次 INFO，单独刷新会造成数字不一致）；
  刷新期间按钮禁用、图标旋转。命中率按阈值着色（≥95% 正常、<90% 提示）。
  卡片用 `auto-fit + minmax(200px, 1fr)` 排布，挤压到阈值以下自动换行。
  注：Lua 内存字段存在版本差异（7.0+ 才有 `used_memory_lua_human`），
  早期版本回退到字节数 `used_memory_lua` 并换算展示。
- **Redis 信息详情卡片**：概览下方的整行卡片，按 INFO 段落（Server / Clients / Memory /
  Persistence / Stats / Replication / Cluster / Keyspace）展示完整字段。
  - **按需加载**：INFO 全量输出可能几十 KB，不随连接一起取，首次渲染时拉一次；
    连接切换会清空重取，避免 `run_id`、`config_file` 这类实例强绑定字段串台
  - 段落用 CSS `columns` 自然分栏（各段字段数差异大，grid 固定列会留大片空白），
    支持逐段折叠；字段名做中文化映射，未收录的生僻项原样展示
  - 值超长时省略并挂 tooltip，保证"能扫"而非"全露出来"
- **欢迎页**：无任何连接配置时，主区域展示本机运行环境（Electron / Chromium / Node / V8 / 平台）
  与 Redis 速查信息（默认端口、连接串格式、常用命令）
- **全局设置**：界面字号（12–16px，由 `--fs-base` 推导全套字号）、界面字体、代码字体、
  界面密度、每页加载键数、键名默认分隔符、删除前二次确认、日志保留天数，
  以及**主题、视图模式（树形/平铺）、CLI 展开状态、上次使用的连接与库、树节点展开状态**；
  持久化于配置文件 `settings.json`
  - **位置（便携模式）**：程序目录旁的 `config/`，整个文件夹拷走即可带走全部配置与日志。
    若程序目录不可写（如装在 `C:////////Program Files\` 下），自动回退到系统目录
    （Windows `%APPDATA%\\RedisDocter\`），并在设置界面如实标注回退原因
  - 也可用环境变量 `REDISDOCTER_CONFIG_DIR` 指定任意目录
  - 目录解析见 `electron/services/config-path.ts`（结果缓存，避免每次读写都试写文件）
- **操作日志**：仅记录**手动操作**（CLI 命令、键的增删改、连接与配置变更）。
  记录点在 IPC 层，主进程内部的自动任务不经过 IPC，因此天然不会入日志；
  读取类操作（scan / value / info）同样不记录，避免浏览行为淹没关键操作。
  文件按天分片存放于 `<配置目录>/logs/yyyymmdd.log`，单行一条便于 grep，
  支持按日期 / 连接 / 关键字筛选，超期文件自动清理（默认保留 30 天）。
  **运维视角分级**：删除类操作标红（`danger`）、变更类（写入 / 新建 / 重命名 / TTL / 保存配置）标琥珀（`change`）——
  左侧色条 + 操作名着色，并可一键「仅看变更」筛掉命令执行与连接等常规记录。
  分级由 `src/utils/log.ts` 的 `logSeverity()` 按操作名关键词判定，新增操作会自动归位；
  命令行里的 `FLUSHALL` / `FLUSHDB` / `SHUTDOWN` 亦按 `danger` 标注（同时匹配详情内容）
- **键列表分页**：基于 `SCAN` 游标式加载，底部显示「已加载 N / 库总数」，
  提供「加载更多」（再取一页）与「加载全部」（连续扫描至游标归零，上限 5000 键防止拖垮界面）
- **键右键菜单**：树形与平铺两种模式共用一份菜单（树节点通过 emit 上报右键，
  由 `KeyBrowser` 顶层统一渲染）—— 若每个递归节点各挂一份，长列表下会堆满隐藏浮层。
  菜单有**两种形态**，判定依据是「有无子节点 + 是否为真实键」（**不是单纯按深度**）：

  | 目标 | 触发条件 | 菜单内容 |
  |---|---|---|
  | 单键 | 平铺项 / 任意真实存在的键（`node.leaf`） | 查看值 · 复制（键名/键值/为命令）· 管理（重命名/TTL）· 删除键 |
  | 子树 | 顶层节点**且有子节点**（`depth === 0 && children.length > 0`） | **批量删除 N 个键** |

  ⚠️ **顶层不等于子树**：无分隔符的键（如 `healthcheck`）在树里同样是顶层，
  但它是原子节点而非前缀 —— 必须走单键菜单，否则会既丢掉全部单键操作，
  又把删除文案变成别扭的「批量删除 1 个键」。
  子树目标代表一个前缀，删除语义是**批量删除该前缀下的全部键**（含子树内所有层级，
  以及节点自身若也是键的情况）。深层目录节点（只有子节点、自身不是键）不响应。
  **右键原子键会同步选中该行**（仅置选中态，不触发值读取 —— 要看值请点菜单里的「查看值」）；
  前缀子树不参与选中，因为它本身不是一个键、没有值可查看。
  「复制键值」在目标非当前键时会先读取一次（键列表只含元信息，不含值）；
  「复制为命令」只生成**读取类**命令（`GET`/`HGETALL`/`LRANGE`…），不生成删除等高危命令，避免误粘贴执行。
  菜单图标统一使用 SVG（`DialogIcon`）而非 emoji / 特殊字符 —— emoji 由系统彩色字体渲染、
  与线条图标风格冲突且跨平台字形差异大，符号类字符的基线与字宽还会随字体变化导致对不齐。
  菜单在**渲染后量取真实尺寸**再决定翻转与钳制（两种形态高度差约 3 倍，用固定值估算会让矮菜单跳位），
  Esc / 点击空白 / 窗口缩放均可关闭。
- **删除确认**：删除键前弹出确认框，采用「一句话说明 + 结构化明细 + 预览 + 风险提示」四层结构 ——
  单键给出**键名 / 类型 / 过期时间**便于核对对象；批量给出**数量**与**待删键名列表**（超过 30 个标记「已截断」）。
  确认按钮为危险色，文案随数量变化（如「删除 12 个键」）。可在设置中关闭。
- **全局提示（tooltip）**：项目**不使用原生 `title`**，统一走自绘的 `v-tip` 指令。
  原生 tooltip 由系统绘制、延迟约 1 秒、样式不可控，暗色主题下会突兀地弹出一块亮色气泡。
  自绘方案在 `App.vue` 挂载唯一实例（`AppTooltip.vue`），所有 `v-tip` 共用：
  ```vue
  <button v-tip="'复制全部内容'">…</button>            <!-- 纯文本 -->
  <span v-tip="row.field">{{ row.field }}</span>       <!-- 动态文本 -->
  <button v-tip="{ text: '重新读取该键', placement: 'bottom' }">…</button>
  ```
  规则：**默认上方显示，空间不足自动翻转**；超过 40 字自动换行（`maxWidth: 320px`），
  短标签保持单行；水平方向钳制在视口内；滚动 / 缩放 / 点击 / 元素卸载时自动收起。
  定位算法由 `npm run check:tip` 做 8 个场景的断言覆盖。
  ⚠️ **`v-tip` 与 `title` 不可共存** —— 同时存在时浏览器仍会弹出系统提示，两个气泡重叠。
  另注意：`PromptDialog` 等组件上的 `title` 是**组件 prop**（弹窗标题），不是提示，不要误改。

## 后续规划（建议按序推进）

1. **连接能力补全**：哨兵 / 集群模式、SSH 隧道、连接导入导出
2. **性能与体验**：大 key 分页加载、键树形分组（按 `:` 分隔）、虚拟滚动
3. **功能增强**：慢日志、监控指标曲线、发布订阅、内存分析（`MEMORY USAGE`）
4. **工程化**：单元测试（Vitest）、图标资源、自动更新（electron-updater）、CI 打包

---

## 安全说明

- 渲染进程开启 `contextIsolation`、关闭 `nodeIntegration`，仅通过白名单 IPC 访问主进程能力
- 连接密码优先调用系统钥匙串加密；仅在钥匙串不可用时降级为明文存储（以 `raw:` 前缀标记）
- 生产构建可进一步收紧：为渲染进程加载 `Content-Security-Policy`、启用 `sandbox: true`（需将 preload 改为无 `require` 的纯 IPC 桥）
