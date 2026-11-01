# Keyper

简体中文 | [English](README.en.md)

**官网 / 下载：<https://keyper-av7duw3mf53.qoder.zone/>**

基于 **TypeScript + Electron + React 19 + electron-builder** 的跨平台键值缓存管理工具。

**同时支持 Redis 与 Memcached**：两者作为彼此隔离的引擎模块接入 ——
配置、连接池、日志、搜索历史均按引擎分开存放，一个模块的异常不会影响另一个。
新增引擎只需实现一个适配器并注册，不需要改动已有模块的代码路径。

| 引擎 | 能力 |
| --- | --- |
| **Redis** | 多库、六种数据结构（string / hash / list / set / zset / stream）、Pub/Sub、慢查询、键内存分析、监控曲线、键空间通知、SSH 多级跳板、内置 CLI |
| **Memcached** | 统计与命中率、全量键浏览（`lru_crawler metadump`，旧服务端回退 `stats cachedump`）、分页加载、单键查看与增删、批量删除 / TTL / 前缀重命名、监控曲线、`flush_all`、运行参数查看 |

> 本项目起源于 RedisDesktop（Vue 3 版）的 React 移植；主进程、preload、IPC、
> shared 类型契约、打包配置沿用其结构，渲染层已按多引擎架构重构。

当前版本：`1.0.11`

当前版本变更（1.0.10 → 1.0.11）：

- **安装器重做为三段向导**：安装「准备 → 正在安装 → 完成」，卸载「选项 → 正在卸载 →
  完成」，页顶常驻步骤条。「准备」页集中环境自检、安装位置（原生按钮选目录）与
  快捷方式 / PATH 勾选 —— 桌面与开始菜单默认勾选，写入用户 PATH 默认不勾选
- **向导窗体放大**：内页从模板的 450×210 放大到 600×315 并按新画布重排；步骤圆点
  与完成徽标改用窗口 region 裁圆 + 文字字形，去掉预渲染位图铺底色冒充透明的做法
- **卸载默认保留配置**：`config/` 移到安装目录同级的 `Keyper-config`，重装时自动接回；
  只有在卸载选项页明确勾选「同时删除配置数据」才会清理
- **升级沿用原目录**：检测到已安装时锁定安装目录并接回保留配置，
  不再出现两套选目录界面
- **连接项悬停身份链路面板**：连接列表悬停即显示名称、地址、引擎、SSH 隧道与
  凭据状态，替代原先必须点进编辑弹窗才能确认的排查路径
- **README 顶部补官网与下载入口**

上一版（1.0.9 → 1.0.10）：

- **传输弹窗统一**：导入连接 / 导出连接 / 从连接串导入三个弹窗接入同一套
  `DialogShell`，拖拽、关闭按钮、焦点管理与无障碍描述一致；
  同时移除三份重复的弹窗外壳代码
- **导出摘要卡**：导出前集中展示连接总数、Redis / Memcached 分布、
  传输格式（`keyper.connections v1`）与凭据状态；勾选「包含凭据」后
  摘要同步切换为「包含（明文）」
- **导入预览与开关**：引擎标签按 Redis / Memcached 品牌色区分；
  「按 ID 覆盖」改为整行可点开关，补充悬停与键盘焦点反馈；
  非法条目列表限高滚动，不再撑长弹窗
- **URI 批量列表整行显示**：列表固定显示 7 整行，第 8 行起滚动，
  最后一行不再只露半截
- **修复导入预览提前过期**：一次性令牌曾被提前消费，写盘失败后预览立即失效、
  只能重新选文件；改为保存成功后再释放，失败可直接重试
- **统一条目校验**：文件导入与 URI 批量导入共用字段白名单，
  非法端口 / 库号 / 连接池大小与重复 ID 走同一套规则；
  `pinned`、`credentialError` 等运行时字段仍不会写入传输文件
- **公共组件抽取**：新增 `Tag` / `InlineNotice` / `SwitchRow` / `EngineTag`，
  把传输弹窗里重复的状态胶囊、警示条、开关行与引擎标签收敛为单一样式

更早（1.0.8 → 1.0.9）：

- **修复复制功能失效**：权限收紧时一律拒绝权限探测，导致
  `navigator.clipboard.writeText` 抛 `NotAllowedError`，而
  `document.execCommand('copy')` 降级路径在新版 Chromium 已废弃 ——
  复制键名 / 复制值 / 复制连接地址等 16 处调用全部失败。
  现按实际权限名放行 `clipboard-read`（Chromium 的 `writeText`
  写入前会先请求该权限做探测），其余权限仍全部拒绝
- **修复提示（toast）一闪而过**：渲染层曾有一个 200ms 的隐藏定时器，
  把 store 里配置的 5~6.5 秒覆盖掉，提示只显示一帧。
  删除该定时器，显隐统一由 store 控制；成功类时长放宽到 6 秒
- **值区头部还原为「胶囊类型 | key」**：取代报头（masthead）的三段式布局，
  第一行胶囊类型 + 键名 + 右侧操作，第二行 `TTL | encoding | 大小`
- **头部间距与对齐**：补回被误删的元信息行样式（三项间距 14px、
  字号提升到 12px、标签与值分色阶），头部内边距 14px；
  修正右侧 ⋮ 按钮因 inline 基线导致的垂直不居中

更早（1.0.7 → 1.0.8）：

- **大 key 分页加载**：hash / list / set / zset / stream 不再一次读全量。默认每页 500 条，
  已加载上限 20000 条；值区底部「加载更多」按游标继续取 —— hash / set 用 SCAN 游标，
  list / zset 用偏移量，stream 用上一页最后的 entry ID。刷新当前键时按已加载数量重读，
  不会退回第一页；SCAN 跨页重复返回的成员在合并时去重
- **Redis 键列表增量刷新**：工具栏刷新改为原地替换 —— 不清空列表、不闪骨架屏，
  按当前已加载数量重扫当前匹配模式；未变化的键复用原对象，列表行不重绘；
  选中键若不在新结果里，先用单键查询核实，确认已被删除才清空值区
- **五种表格类型虚拟滚动**：hash / list / set / zset / stream 的表格只渲染视口内的行
  （可变行高实测缓存 + 前缀和二分查找 + 上下等高占位），string 的逐行视图同样窗口化；
  万级元素的键也能流畅滚动，粘性表头、列宽拖拽与行内操作不受影响
- **监控指标曲线**：Redis 概览新增「监控」页签 —— 每 2 秒采样一次、保留 450 个点，
  支持 1m / 5m / 15m 三段窗口与暂停 / 清空；六个指标（内存、Ops/sec、客户端连接、命中率、
  键总数、淘汰数）各配一张纯 SVG 迷你折线图，并显示当前区间的最小 / 最大值。
  Memcached 详情页的「监控」页签复用同一套采样与绘图骨架，只把数据源换成 `stats`：
  Ops/sec 由累计命令计数的相邻采样差值换算，淘汰数按每分钟增量绘制
- **键空间通知**：概览新增「键空间通知」页签。可直接勾选 `notify-keyspace-events` 的
  频道位（K / E）与类型位（A / g$lshzxetd / m / n）并写回服务端，值预览实时拼接；
  监听使用独立的订阅连接（与 Pub/Sub 互不干扰），事件流保留最近 200 条，
  支持按事件名 / 键名 / 频道过滤，切换连接或离开面板即退订
- **Memcached 批量操作**：键栏进入批量选择后，可对选中的缓存项执行删除、TTL 修改或前缀重命名。
  值区切换为批量面板：清单可搜索、排序，逐行显示当前值与目标值，执行时逐键推进并可随时中止；
  重命名按前缀替换规则预览，目标键已存在时跳过并标记失败；全部结束后只广播一次键列表刷新
- **应用内增量更新**：接入 electron-updater，在主页「检查更新」面板内直接下载并安装。
  下载走 blockmap 差分，只传输与本地版本不同的分块，显示百分比、已下载 / 总量与速度；
  面板可隐藏而下载继续，完成后可选「稍后」或「重启并安装」；未打包版本自动跳过
- **GitHub Actions CI 与发布流水线**：push / PR 跑 i18n 校验、类型检查、单元测试与构建；
  推送 `v*` 标签时在 Windows 上打包 NSIS 并发布 Release（含 `latest.yml`、blockmap 与
  `app-update.yml`），标签版本与 `package.json` 不一致会直接失败
- **安装包体积优化**：Electron 运行时语言包从 50+ 种裁到界面真正使用的 3 种
  （en-US / zh-CN / zh-TW），渲染层依赖改归 devDependencies 使 asar 只含生产依赖；
  安装包从 84.0 MB 降到 75.4 MB（-10.3%），app.asar 从 18.9 MiB 降到 3.7 MiB
- **连接导入导出**：侧栏头部的导入 / 导出按钮（transfer 图标）与主页「从连接串导入」共用一套弹窗 ——
  导出为带格式头的 JSON（两种引擎 + 多级 SSH，凭据默认剥离，可显式勾选并二次确认）；
  导入先出逐条预览（冲突 / 已连接 / 非法条目 / 凭据标签），默认新建 ID、可切换按 ID 覆盖，
  已连接项在覆盖时跳过；URI 批量导入支持注释、最多 200 行、逐行报错且只导入合法行
- **渲染层沙箱与 CSP 收紧**：启用 `sandbox: true`，渲染层与 preload 均拿不到
  `require` / `process` / `module` / `Buffer`，能力仅经 contextBridge 暴露；加载严格
  `Content-Security-Policy`（脚本走 sha256 hash、样式不含 `unsafe-inline`），
  生产用构建产物里的 `<meta>`（`file://` 下响应头无效）、开发由主进程注入带 HMR 放行的
  另一套；同时拦截应用内导航与 `<webview>` 挂载、拒绝全部权限请求，
  外链只放行 https 与 GitHub
- **监控默认不采样**：概览「监控」页签改为显式「开启」后才每 2 秒采样，
  区分「从未开启 / 采样中 / 已暂停」三态，按钮文案随之变化；
  打开概览看一眼时不再在后台持续请求
- **electron-builder 升级到 26**：配置无需改动，安装包体积再降 3.53%

更早（1.0.6 → 1.0.7）：

- **全应用图标按钮统一 hover 阴影**：刷新 / 新建 / 弹窗关闭 / 更多操作 / 侧栏新建与折叠 /
  侧栏展开 / 页签溢出 / 顶栏图标 / 窗口控件 / 键行删除 / 批量面板行操作 / 值行操作 /
  搜索历史删除 / 主题与语言切换 / 通知浮层关闭，共 15 类图标按钮在 hover 时统一浮起 ——
  与页签、连接磁贴共用 `--lift-shadow`（分层双影，只纵向上浮不位移），9 套皮肤自动跟随；
  只加阴影不改背景，各按钮原有的强调色反白与关闭键红色警示保持不变
- **连接磁贴改分层双影**：1px 近影定轮廓 + 大模糊负 spread 的远影收在卡片正下方造景深，
  数值按深浅主题分组（亮色底改冷灰蓝，避免纯黑影在白底上发脏）
- **页签与键栏 mini 按钮阴影与磁贴同款**：hover 与选中态共用同一档影子；
  选中态只叠阴影、不加 inset 描边（描边是连接磁贴选中态的语义，页签不借用）
- **Memcached 键栏补齐状态样式**：L1 / L2 / 全部展开 / 全部折叠 / 批量选择五个按钮
  原先只有尺寸、没有 hover 与选中反馈，现与 Redis 键栏一致
- **README 增补英文版**：新增 `README.en.md`，章节、表格、代码块与截图与中文版一一对应，
  两版顶部可互相切换
- **原生 tooltip 全面替换为自绘提示**：连接页签、慢查询表格、分栏拖拽把手、值区书签与
  「⋯ 更多」面板、欢迎页按钮、设置页路径、五个编辑弹窗等 13 个组件里的原生 `title`
  全部换成项目统一的 `tipProps`（原生提示由系统绘制、延迟约 1 秒、暗色下会弹亮色气泡）；
  同时修掉嵌套提示的缺陷 —— 鼠标从书签里的关闭 × 移回书签主体时，提示会消失且不再恢复
- **主页卡片配色跟随皮肤**：卡片内容面此前九套浅色皮肤全是纯白（覆盖规则写在
  `@layer components` 里，被 Tailwind 的 utilities 层静默压过）。改为按「面板色 + 页面底色」
  现算，薄荷 / 雾蓝 / 极光三套掺入各自主色，三套一眼可辨；九宫格与底部信息卡改为透明，
  内部用虚分隔线分组，悬停底色走全局 `--bg-hover`
- **值区二级页签加语义图标**：Redis 信息详情 / 慢查询日志 / 键内存分析 / Pub-Sub 订阅四项，
  以及 Memcached 的统计 / 设置两项，标题前统一加图标，颜色随页签文字深浅
- **布局修复**：新建连接按钮的 + 号此前比文字中心高 1.5px（内容层没有 flex、按基线排列），
  已改为居中对齐
- **值区头部改为报头（masthead）**：取代原先的「票根 + 水印」—— 上行是 9px 大写的类型眉标
  （取该类型的徽标色），下行 18px 键名与右对齐的 TTL / encoding / 大小同排，⋮ 菜单悬在右上角；
  string 值区的六个操作同步收进一个分段控件，与键级 ⋮ 菜单分工更清楚

更早（1.0.4 → 1.0.6）：

- **三语言界面**：简体中文 / 繁體中文 / English，主页右上角语言菜单即时切换并持久化；
  首次启动按操作系统语言自动选择；字典改用语义 key（`namespace.camelCase`）并按语言
  拆分到 `lang/` 下的独立文件，`MsgKey` 由英文目录推导、另外两份在编译期校验，
  漏译按「当前语言 → 英文 → key」回退；主进程文案（错误信息、日志等）随设置同步切换；
  新增 `npm run i18n:check` 校验键集、占位符与源码引用
- **顶部卡片改方案 09（无框轻排版）**：Redis 与 Memcached 详情页顶部概览卡去掉边框与底色，
  仅靠留白与细分隔线成组，下方卡片保持原样
- **Memcached 键浏览补齐**：改用 `lru_crawler metadump` 遍历完整 LRU，修复仍处于
  WARM 段的键（如 `group:yufei:2030`）重连后不显示的问题；旧服务端自动回退
  `stats cachedump` 并标注「可能不完整」；按全局「每页加载键数」分页，
  支持加载更多 / 加载全部，与 Redis 键区交互一致
- **修复启动主题闪回**：设置读取完成前不再被默认主题覆盖，已保存的皮肤从首帧生效
- **品牌图标更新**：「红色纯色圆角底 + 白色 K（钥匙齿）」，与界面内 Logo 几何一致

更早（1.0.3 → 1.0.4）：

- **升级 React 19 并接入 React Compiler 1.0**：构建期自动记忆化，`target: 19`
  直接使用 React 自带的 compiler-runtime，不引入额外运行依赖（构建体积 +54.7 kB，
  gzip +23.7 kB）
- **值区多标签保活（`<Activity>`）**：切走的标签只隐藏、不卸载 —— 筛选 / 排序 /
  编辑草稿 / 列宽 / 滚动位置全部保留；切回已缓存的标签立即渲染并静默刷新，不再闪骨架屏
- **操作日志列表**：连接列前置；表头吸顶、操作列固定在右侧，横向滚动时列不漂移；
  时间 / 操作 / 详情 / 连接 / 结果五列支持升降序（时间默认新→旧，文本按中文排序，
  结果列先按 OK / FAIL 分组）；行高下限 30px，紧凑密度下复制按钮不再溢出
- **PixelHeading 动画优化**：逐字字体切换改为直接写 DOM，不再每 50ms 触发整组件重渲染
- **细节修复**：侧栏展开按钮提示文案与图标视觉重心、首页兼容性说明补充 Memcached

更早（1.0.2 → 1.0.3）：

- **集成 Memcached 引擎模块**：与 Redis 完全隔离（独立连接池 / 管理器 / IPC 通道 /
  日志字段），连接列表带引擎角标、新建弹窗可选引擎、日志可按模块筛选
- **Memcached 信息面板**：四张概览卡（服务 / 内存 / 命中 / 状态）+ 统计页签 +
  按 slab 分组的键浏览 + 设置页签（含 flush_all）
- **项目更名为 Keyper**：产品名、appId、安装器配置目录、主题存储键全部更新，
  并保留对旧名（RedisDocter / RedisDesktop）配置与偏好的迁移
- **引擎标识与品牌**：连接列表名称行改用引擎图形标识，新建弹窗引擎卡片同款图形；
  顶栏横版品牌、主页 Logo 立体悬停、CTA 渐变随皮肤切换

更早（1.0.1 → 1.0.2）：

- **值区头部改为票根 + 水印**（75px）：左侧 26px 存根竖排类型名、右缘 mask 咬出半圆撕口，
  票面右侧压 72px 类型首字母水印
- **左侧连接列表改磁贴卡片**（一行一个）：卡片底色/描边/圆角、顶部状态短线、置顶图标紧跟连接名
- **退出确认改自绘弹窗**：列出当前连接中的实例，先并行断开再关窗口，不再用系统原生对话框
- **右侧面板补齐漏移植的 UI**：Pub/Sub 已订阅 chip 清单（可单个退订）、慢查询 ID 列与相对时间、
  慢查询阈值说明
- **按钮统一为胶囊**（999px）：键内存分析分段控件改为凹槽式、开始分析/清空/停止/订阅/发布
  统一到 `.tool` 度量
- **修复**：操作菜单被表头遮挡（`transform` 造成 containing block）、List 编辑弹窗长内容撑爆宽度、
  键名被类型色染色、弹窗文本框随内容增高

累积能力：

三语言界面（简体中文 / 繁體中文 / English）；多标签工作区（每个连接一个标签、关标签即断开、右键菜单/溢出滚动/更多页签下拉）；
值区多标签保活（`<Activity>` 隐藏而非卸载，状态原样保留）；操作日志表头排序与固定操作列；
SSH 多级跳板与连接保活；值区六页签（Redis 信息详情/慢查询日志/键内存分析/Pub/Sub 订阅/监控指标/键空间通知）；
批量 TTL/重命名；全库搜索下沉主进程 + 平铺虚拟滚动；键搜索历史自动补全（按连接与库隔离、
LRU 30 条、配置文件持久化）；树形深层目录右键批量删除；string 双击编辑；
大 key 分页加载（每页 500 / 上限 20000）；键列表原地增量刷新；六种值类型虚拟滚动；
监控曲线（Redis 与 Memcached）；Memcached 批量删除 / TTL / 前缀重命名；
应用内增量更新（electron-updater）；GitHub Actions CI 与发布流水线；
批量删除两键以上走值区面板；9 套皮肤（含极光）；连接凭据失效黄条；
string 值实底行号槽；安装器开始菜单快捷方式勾选页；
错误落盘（渲染层/主进程异常写 `logs/errors-yyyymmdd.log`，带堆栈与 5 秒去重）；
连接导入导出（JSON，默认不含凭据）与 URI 批量导入；
连接列表批量删除（≥3 个才出现入口）；弹窗关闭纪律（普通弹窗禁点遮罩关闭）；
六类型新增入口对称；主页功能导览九宫格；vitest 单元测试


---

## 渲染层状态与组件

| 路径 | 作用 |
| --- | --- |
| `src/store/reactiveStore.ts` | 极简响应式 store（Proxy + 版本号），与 Vue `reactive` 语义等价 |
| `src/store/session.ts` | 单标签会话：扫描/选中/值更新的竞态令牌、本地增删改、批量任务 |
| `src/store/global.ts` | 连接管理、多标签、快照恢复 |
| `src/store/useRedis.ts` | 语境包装：标签树内用 Context，标签外用激活会话代理 |
| `src/hooks/` | 设置、主题、搜索历史、弹窗拖拽、六个值类型编辑器（`valueEditor/`） |
| `src/components/` | 59 个界面组件（`.tsx`）+ `ui/` 原子组件 + `components.css` |

---

## 多语言（i18n）

界面内置简体中文、繁體中文、English 三套语言，可在主页右上角语言菜单即时切换，
选择持久化到 `settings.json`，重启后保持。

| 位置 | 作用 |
| --- | --- |
| `lang/en.ts` | 英文目录，**唯一事实来源**：语义 key + 英文译文，导出 `MsgKey` |
| `lang/zh-CN.ts` / `lang/zh-TW.ts` | 简繁译文，声明为 `Record<MsgKey, string>`，编译期保证不缺不多 |
| `shared/i18n/index.ts` | 语言码、字典查找、`{name}` 插值、回退链；主进程与渲染层共用 |
| `src/i18n/index.ts` | 渲染层入口：`useI18n()`（订阅语言变化）与模块级 `t()` |

设计要点：

- **语义 key**（`namespace.camelCase`，如 `common.cancel`）描述用途而非文案，
  改文案不影响调用点；`MsgKey = keyof typeof en`，拼错 key、漏译、多译都会编译失败；
- 运行时容错回退「当前语言 → 英文 → key」，不会渲染成空白；
- `npm run i18n:check` 全量校验三份字典的键集与占位符一致、英文译文不残留中文，
  并检查源码中 `t()` 的字面量 key 是否存在、是否有从未被引用的 key；
- 组件内用 `const { t } = useI18n()`，在渲染期翻译；主进程 `import { t } from '@shared/i18n'`，
  语言随设置同步（`syncMainLocale`）；
- 模块级常量（主题名、表头映射、TTL 预设等）保存 `MsgKey`，渲染时再 `t(key)`；
- 持久化的操作日志仍写中文操作名（便于 grep 与向后兼容），展示时经 `logActionKey`
  映射为 `MsgKey` 再翻译；
- 语言名始终用本名（English 界面下「繁體中文」不译），`<html lang>` 同步更新。

新增一种语言：在 `lang/` 下加文件并实现 `Record<MsgKey, string>` → 在 `shared/i18n`
的 `LocaleCode` / `LOCALES` / `LOCALE_NAMES` / `LOCALE_HTML_LANG` / `DICTIONARIES`
注册 → 运行 `npm run i18n:check`。

新增文案：在 `lang/en.ts` 按命名空间加语义 key → 在 zh-CN / zh-TW 补同名两条译文 →
源码里 `t('ns.key', { … })` → 运行 `npm run i18n:check`。

---

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 主进程 | Electron 33 + TypeScript 5.7 | 窗口管理、IPC、连接池、引擎注册表 |
| 渲染进程 | **React 19 + Vite 6** | 界面与交互；状态层见 `src/store/` |
| 编译优化 | **React Compiler 1.0** | 构建期自动记忆化，`target: 19` 直接用 React 自带 runtime |
| 通信 | contextBridge + ipcRenderer.invoke | 上下文隔离，渲染进程不接触 Node |
| Redis 客户端 | ioredis 5 | 支持 TLS / ACL / 分页 SCAN |
| 应用内更新 | electron-updater 6 | blockmap 差分下载、下载进度、退出时自动安装 |
| CI / 发布 | GitHub Actions | push / PR 全量校验；打标签构建 Windows 安装包并发布 Release |
| 打包 | electron-builder 26 | Windows NSIS / macOS DMG / Linux AppImage+deb；仅打包 3 个界面语言 |

---

## 目录结构

```
Keyper/
├── electron/                        # 主进程
│   ├── main.ts                      # 应用入口：窗口、单实例、生命周期
│   ├── preload.ts                   # 预加载：contextBridge 暴露 window.redisApi
│   ├── ipc/index.ts                 # IPC 通道注册与统一错误包裹
│   └── services/
│       ├── engines/                 # 引擎模块（彼此隔离）
│       │   ├── registry.ts          # 引擎注册表：适配器登记与查询
│       │   └── memcached/           # Memcached：client / manager / pool
│       ├── connection-manager.ts    # Redis 连接池 + 全部 Redis 命令
│       ├── ssh-tunnel.ts            # SSH 隧道（本地端口转发）
│       ├── connection-store.ts      # 连接配置持久化
│       ├── connection-transfer.ts   # 连接导入导出的文件 IO 与一次性预览令牌
│       ├── credential-crypto.ts     # 凭据加密（safeStorage + 回退）
│       ├── settings-store.ts        # 应用设置持久化（settings.json）
│       ├── search-history-store.ts  # 键搜索历史（LRU 30，按连接与库隔离）
│       ├── log-service.ts           # 手动操作日志（按天分片、超期清理）
│       ├── update-service.ts        # 更新检查（版本页兜底）
│       ├── auto-update.ts           # 应用内更新（electron-updater 差分下载与安装）
│       ├── config-path.ts           # 便携目录解析与回退
│       └── close-signal.ts          # 退出前先断开的信号
├── .github/workflows/               # CI 与发布流水线
│   ├── ci.yml                       # push / PR：i18n、类型检查、单测、构建
│   └── release.yml                  # 标签 / 手动：构建 NSIS 并发布 Release
├── lang/                            # 三份语言字典（语义 key）
│   ├── en.ts                        # English（唯一事实来源，导出 MsgKey）
│   ├── zh-CN.ts                     # 简体（Record<MsgKey, string>）
│   └── zh-TW.ts                     # 繁體（Record<MsgKey, string>）
├── shared/                          # 主进程与渲染进程共享的类型契约
│   ├── types.ts                     # 数据模型
│   ├── api.ts                       # 接口 + IPC 通道常量
│   ├── connection-transfer.ts       # 导入导出纯逻辑：白名单导出 / 解析校验 / 合并策略
│   ├── keyspace.ts                  # 键名空间解析（分隔符 / 前缀）
│   ├── i18n/index.ts                # 翻译核心：语言码、查表、插值
│   └── version.ts                   # 版本解析与比较
├── src/                             # 渲染进程
│   ├── main.tsx                     # 挂载入口
│   ├── App.tsx                      # 整体布局（顶栏 / 三栏 / CLI）
│   ├── api/                         # 数据入口：Electron 走 IPC，浏览器降级 Mock
│   ├── store/                       # defineStore + 会话 / 全局 / 订阅
│   ├── hooks/                       # 设置、主题、搜索历史、弹窗拖拽、值编辑器
│   ├── components/                  # 55 个界面组件 + ui/ 原子组件
│   ├── services/                    # 设置、主题、错误上报
│   ├── utils/                       # 键树、能力探测、格式化、剪贴板等
│   ├── styles/                      # main.css（设计令牌）+ components.css
│   └── preview/                     # 纯浏览器预览页
├── tests/unit/                      # vitest 单元测试（17 个 spec）
├── build/                           # 图标与 NSIS 定制脚本
├── scripts/                         # 开发期探针与截图脚本
├── vite.config.ts                   # 渲染进程 + 主进程构建
├── vitest.config.ts                 # 单元测试配置
└── electron-builder.yml             # 打包配置
```

---

## 常用命令

```bash
npm install          # 安装依赖（国内网络建议配镜像，见下）
npm run dev          # 开发模式：启动 Vite + Electron，支持热更新
npm run dev:web      # 纯浏览器调试渲染层：只起 Vite，不编译/不拉起 Electron
npm run preview      # 预览已构建产物（http://127.0.0.1:4173）
npm run preview:title # 浏览器预览标题动画页
npm run typecheck    # 类型检查（主进程 + 渲染进程）
npm run test         # vitest 单元测试（tests/unit，17 个 spec）
npm run i18n:check   # 校验三份字典的键集、占位符与源码引用一致
npm run build        # 类型检查 + 构建产物到 dist/ 与 dist-electron/
npm run dist         # 当前平台打包
npm run dist:win     # 打包 Windows 安装包
npm run dist:win:alt # 打包 Windows 到 release/<版本>-final（保留上一版产物时用）
npm run dist:win:publish # 打包并发布到 GitHub Releases（需 GH_TOKEN，版本号须与标签一致）
```

构建产物落在 `release/<版本>/`，文件名形如 `Keyper-1.0.11-win-x64.exe`；
同目录还会生成 `latest.yml`、`*.blockmap`（增量更新分块索引）与打包进安装目录的
`app-update.yml`（更新源配置）。

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
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./Keyper.exe
```

需要定位启动问题时，可开启主进程诊断日志：

```bash
KEYPER_DEBUG_LOG=/tmp/rd.log ./Keyper.exe
# 日志会记录：module loaded → requestSingleInstanceLock 结果 → app ready → 窗口创建
```

---

## 持续集成与自动更新

| 工作流 | 触发 | 内容 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push（任意分支）/ PR 到 master | `npm ci` → `i18n:check` → `typecheck` → `vitest` → `vite build` |
| `.github/workflows/release.yml` | 推送 `v*` 标签 / 手动运行 | 校验标签与 `package.json` 版本一致 → 从标签附注导出 `release-notes.md` → Windows 打包 → 上传安装包、`latest.yml` 与 blockmap；标签触发自动发布 Release，手动运行默认只构建 |

### 应用内更新

打包版在主页「检查更新」面板里走 electron-updater：检查 GitHub Releases 的 `latest.yml`，
发现新版本后可直接下载并安装。下载使用 blockmap 差分，只传输与本地安装包不同的分块；
面板显示百分比、已下载 / 总量与速度，收起面板不中断下载，完成后可选「稍后 / 重启并安装」，
选择稍后时退出应用会自动安装。

- 更新源配置在 `electron-builder.yml` 的 `publish` 字段，`app-update.yml` 随安装包生成；
  可用环境变量 `KEYPER_UPDATE_URL` 指向内网 / 镜像的 generic 更新源
  （目录内放 `latest.yml` 与安装包即可），覆盖打包时写入的配置；
- 开发态 / 未打包版本没有 `app-update.yml`，自动更新直接跳过，回退到版本页检查（只提示新版本并打开下载页）；
- 发布：`npm run dist:win:publish`（需 `GH_TOKEN`），或推送与版本号一致的 `v*` 标签由 CI 构建；
- 发版说明只写一处：附注标签正文（`git tag -a`）由 Release 工作流导出为项目根目录的
  `release-notes.md`，electron-builder 自动把同一份文案同时用作 GitHub Release 正文与
  `latest.yml` 的 `releaseNotes`（客户端「检查更新」面板显示的就是它）；该文件是 CI 产物，不入库；
- 增量元数据（`latest.yml` 与 `*.blockmap`）必须与安装包一同上传，否则客户端只能全量下载。

---

## 安装器（NSIS 定制）

安装包由 `build/` 下的 NSIS 脚本定制。`installer.nsh` 是唯一入口
（`electron-builder.yml` 的 `nsis.include`），其余脚本由它 `!include`：

| 文件 | 职责 |
| --- | --- |
| `installer.nsh` | 汇总入口：挂载钩子、写入/清理 PATH，并 include 下面各文件 |
| `installer-env.nsh` | 环境检测：系统版本 / 位数 / 磁盘 / 目录可写探针 |
| `installer-prep.nsh` | 安装「准备」页：环境卡片 + 安装位置 + 快捷方式与 PATH 勾选 |
| `installer-finish.nsh` | 安装「完成」页：版本、目录、快捷方式、PATH、配置摘要 |
| `installer-uninstall.nsh` | 卸载「选项」页（保留 / 删除配置）与卸载「完成」页 |
| `installer-theme.nsh` | 共用绘制宏：色板、卡片、文字、region 圆点、原生按钮 |
| `installer-resize.nsh` | 窗体运行时放大与缩回模板（见「窗体尺寸」） |
| `installer-upgrade.nsh` | 已安装检测：升级模式沿用原目录、接回用户数据 |
| `installer-config.nsh` | 配置的保留与清理（卸载默认移走 `config/`） |
| `icon.ico` / `installerHeader.bmp` | 应用图标与向导头部品牌图（已入库） |

### 三段向导

安装与卸载都是「准备 / 选项 → 进度 → 完成」三步，步骤条常驻页顶。

| 场景 | 页面 | 要点 |
| --- | --- | --- |
| 全新安装 | 准备 → 正在安装 → 完成 | 目录可改（原生按钮选文件夹）；桌面与开始菜单默认勾选，写入用户 PATH 默认不勾选 |
| 升级 / 重装 | 准备（目录锁定）→ 正在安装 → 完成 | 沿用原目录，自动接回 `<安装目录同级>\Keyper-config` |
| 卸载 | 选项 → 正在卸载 → 完成 | 配置默认保留，只有明确勾选删除才清理；不允许后退与取消 |
| `/S` 静默 | 跳过全部自定义页 | 升级流程调用旧卸载器时一律保留配置；卸载里的 `MessageBox` 必须带 `/SD`，否则卡死 `ExecWait` |

### 环境检查做了什么

本应用是 Electron 应用，运行时（Node / Chromium / V8）随包携带，ioredis 与 ssh2 也都是
随包的库，主进程**不调用任何外部程序**。因此传统意义上的「检查 VC++ / .NET / Node.js」
在这里是无效检查 —— 装一个只看不用的检查页只会增加点击，一个失败案例也拦不住。

实际检测的是会导致「装完打不开」的系统条件，结果直接画在「准备」页的环境卡片上
（此时 `$INSTDIR` 已是最终值，磁盘与权限才测得准）：

| 检查项 | 判定 | 不通过时 |
| --- | --- | --- |
| Windows 版本 | 内部版本 ≥ 17763（Win10 1809） | 卡片标红，需勾选「我了解上述风险，仍然继续安装」 |
| 系统位数 | 必须 x64 | **硬性中止** |
| 磁盘空间 | ≥ 600 MB | 卡片标红，需勾选确认后继续 |
| 安装目录 | 实写探针文件验证 | 卡片标红，需勾选确认后继续 |

「准备」页离开时还会校验安装位置：必须是盘符或 UNC 完整路径，尾部分隔符自动去掉，
只选到父目录（`C:\Apps`）时自动补上应用子目录（`C:\Apps\Keyper`）。

### 窗体尺寸

NSIS 模板的内页固定 300×140 DLU（96dpi 下 450×210），MUI2 只取句柄配色、不重排控件。
`installer-resize.nsh` 在运行时按实测尺寸把画布放大到 400×210 DLU（600×315 px），
并连带重排头部、分隔线、页脚、三个按钮与页内控件。两条硬约束：

1. 改动必须由 **UI 线程**发出。卸载段跑在段线程，段线程的 `SetWindowPos` /
   `SetWindowText` 会排队到整段结束才生效，所以卸载进度页改为「进段前缩回模板尺寸、
   完成页再放大」；安装进度页能拿到 SHOW 回调，直接放大即可。
2. 模板进度页（instfiles）的控件在 `$HWNDPARENT` 下的一个 `#32770` 子对话框里，
   判据用「该对话框内存在 `msctls_progress32` 子窗」—— 不能用可见性，
   也不能用控件 ID（nsDialogs 自绘控件同样从 1000 起编）。

### PATH 环境变量

「准备」页勾选后才把安装目录写入**当前用户** PATH（`HKCU\Environment`），默认不勾选；卸载时移除：

- 用 `WriteRegExpandStr` 写 `REG_EXPAND_SZ`，保留 `%USERPROFILE%` 一类变量不被固化
- 幂等：重复安装不会产生重复条目（实测验证）
- 卸载按分号边界逐段比对，不会把 `Keyper2` 误伤成 `Keyper`
- 升级前 PATH 里已有该目录时记为 `RdPathWasPresent`，即使用户没再勾选也不会被重装过程丢掉

### 踩过的坑（修改时注意）

1. **`installer.nsh` 会被编译两次**（安装器一次、卸载器一次）。只在安装器用到的
   `Var` / `Function` 必须包在 `!ifndef BUILD_UNINSTALLER` 里，`un.` 前缀函数必须包在
   `!ifdef BUILD_UNINSTALLER` 里。否则会报 `warning 6010 / 6001 / 6020`，而
   electron-builder **默认把 NSIS 警告当错误**，打包直接失败且报错信息里只有一行 `Error output:`。
2. **`build/*.nsh` 一律带 UTF-8 BOM**。本机 makensis 是 3.04 ANSI 版，没有 BOM 会把中文
   注释与文案按本地码解析成乱码。
3. **自定义页的槽位是固定的**：安装侧用 `customPageAfterChangeDir`（环境检查/准备页）与
   `customFinishPage`（完成页），卸载侧用 `customUnWelcomePage`（选项页）与
   `customUninstallPage`。后者在模板 `MUI_UNPAGE_INSTFILES` **之后**、`MUI_UNPAGE_FINISH`
   **之前**展开，因此可以用它给模板完成页挂 `PRE` + `Abort` 实现跳页。
   `MUI_PAGE_CUSTOMFUNCTION_SHOW` 是一次性的：MUI2 的页面宏 `Call` 完就 `!undef`，
   所以它必须定义在目标页宏展开之前；卸载侧紧跟在进度页前面的「为谁安装/卸载」页
   （`multiUserUi.nsh` 的 `PAGE_INSTALL_MODE`）会先把它吞掉，卸载进度页拿不到 SHOW 钩子，
   安装进度页则能正常拿到（`RdInstFilesShow`）。
4. 在 `-D` 之外自行 `!include "StrContains.nsh"` 会触发未引用警告，PATH 判重改用
   分号边界拼接即可。
5. 步骤圆点与徽标用**窗口 region 裁圆**（纯色 STATIC + 文字字形），不要再用预渲染 BMP
   铺底色冒充透明 —— GDI 位图没有 alpha 通道，换皮肤或换 DPI 就会露出色块边。

### 图标

窗口图标与安装器图标都读取 `build/icon.ico`（`electron-builder.yml` 的
`win.icon` / `installerIcon` / `uninstallerIcon` / `installerHeaderIcon`），
文件已入库，没有生成脚本；替换时提供 256×256 PNG → 多尺寸 ICO 即可。

图标为「红色纯色圆角底 + 白色 K（钥匙齿）」：底色为品牌红 `#CE3F33`，无渐变、无高光；
K 用矢量笔画手绘而非字体 —— 字体字形墨迹只有字号的 66%，缩到 16×16 时白色像素会归零，
任务栏上只剩一个纯红方块。几何与 `src/components/BrandMark.tsx` 的 128×128 坐标系一致。

---

## 界面预览

| 方式 | 命令 | 看到什么 | 适用场景 |
| --- | --- | --- | --- |
| 浏览器跑真组件 | `npm run dev:web` → 打开 `http://127.0.0.1:5173` | 真实 React 组件，支持热更新；数据走 `src/api/mock.ts` | 日常调界面，不必等 Electron 窗口；下方截图即由此生成 |
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

### 截图

> 以下截图取自 `npm run dev:web` 的浏览器预览，数据全部来自 `src/api/mock.ts`
> 的演示配置 —— 不包含任何真实环境的地址、账号或业务键名。

#### 主页

<p>
  <img src="docs/screenshots/home-dark.png" width="49%" alt="主页 · 暗色" />
  <img src="docs/screenshots/home-light.png" width="49%" alt="主页 · 亮色" />
</p>
<p>
  <img src="docs/screenshots/home-aurora.png" width="49%" alt="主页 · 极光" />
  <img src="docs/screenshots/home-sakura.png" width="49%" alt="主页 · 樱花" />
</p>

#### 键浏览器 · 9 套皮肤

同一份数据、同一套布局，只切换 `data-theme`。配色由 CSS 变量驱动，
组件本身不感知主题，因此新增皮肤只需补一组变量。

| 暗色 | 亮色 | 深海 |
| :---: | :---: | :---: |
| ![](docs/screenshots/key-browser-dark.png) | ![](docs/screenshots/key-browser-light.png) | ![](docs/screenshots/key-browser-ocean.png) |

| 晒淡 | 森林 | 樱花 |
| :---: | :---: | :---: |
| ![](docs/screenshots/key-browser-solarized.png) | ![](docs/screenshots/key-browser-forest.png) | ![](docs/screenshots/key-browser-sakura.png) |

| 薄荷 | 薄雾 | 极光 |
| :---: | :---: | :---: |
| ![](docs/screenshots/key-browser-mint.png) | ![](docs/screenshots/key-browser-mist.png) | ![](docs/screenshots/key-browser-aurora.png) |

#### 树形视图与键值查看

树形按分隔符逐段建层，目录节点显示子树内的键数量；右侧按类型渲染不同的
查看器 —— hash 走字段表格（含字段级 TTL 列），zset 走「成员 + 分值」表格。

<p>
  <img src="docs/screenshots/key-browser-tree.png" width="49%" alt="树形视图 · 暗色" />
  <img src="docs/screenshots/key-browser-tree-light.png" width="49%" alt="树形视图 · 亮色" />
</p>

<p>
  <img src="docs/screenshots/key-value-string.png" width="49%" alt="string 值查看" />
  <img src="docs/screenshots/key-value-hash.png" width="49%" alt="hash 值查看" />
</p>

<p>
  <img src="docs/screenshots/key-value-zset.png" width="49%" alt="zset 值查看" />
  <img src="docs/screenshots/key-value-hash-light.png" width="49%" alt="hash 值查看 · 亮色" />
</p>
<p>
  <img src="docs/screenshots/key-value-string-light.png" width="49%" alt="string 值查看 · 亮色" />
</p>

值区头部是**报头（masthead）**：上行是 9px 大写的类型眉标，取该类型的徽标色；
下行 18px 键名，同排右对齐显示 TTL / encoding / 大小，⋮ 操作菜单悬在右上角。
类型不再占用行首徽标的位置，键名独占一整行 —— 长键名能多显示约 40px。

#### 服务端信息面板

右上六页签：**Redis 信息详情**（9 个段落，服务器 / 客户端 / 内存 / 持久化 / 统计 / 复制 / CPU / 集群 / 键空间，
每段可折叠）、**慢查询日志**、**键内存分析**（按前缀聚合，扫描上限 10000 键，结果保留内存前 200 的前缀）、
**Pub/Sub 订阅**（频道实底 chip、模式虚线 chip，点 × 单个退订）、**监控**（2 秒采样的六条指标曲线）、
**键空间通知**（配置位勾选 + 事件流）。Memcached 详情页为统计 / 设置 / 监控三页签，
监控与 Redis 共用采样与绘图骨架。

<p>
  <img src="docs/screenshots/overview-info.png" width="49%" alt="Redis 信息详情 · 暗色" />
  <img src="docs/screenshots/overview-info-light.png" width="49%" alt="Redis 信息详情 · 亮色" />
</p>

<p>
  <img src="docs/screenshots/overview-slowlog.png" width="49%" alt="慢查询日志" />
  <img src="docs/screenshots/overview-memory.png" width="49%" alt="键内存分析" />
</p>

<p>
  <img src="docs/screenshots/overview-pubsub.png" width="49%" alt="Pub/Sub 订阅" />
</p>

#### 检索、CLI 与操作日志

全库搜索把 `SCAN` 下沉到主进程，边扫边推送进度、可随时中止；CLI 按连接分标签，
执行结果直接回显；操作日志只记录手动操作，支持按日期 / 连接筛选。

<p>
  <img src="docs/screenshots/search-result.png" width="49%" alt="全库搜索" />
  <img src="docs/screenshots/cli-console.png" width="49%" alt="CLI 控制台" />
</p>

<p>
  <img src="docs/screenshots/operation-log.png" width="49%" alt="操作日志" />
  <img src="docs/screenshots/dialog-connection.png" width="49%" alt="新建连接" />
</p>

#### 新建连接

基于 Cult UI 的 shadcn 原子组件（Dialog / Input / Label / Switch / Select / Button），
配色走语义 token，9 套皮肤下自动跟随；支持 SSH 隧道与多级跳板。

<p>
  <img src="docs/screenshots/dialog-connection.png" width="49%" alt="新建连接 · 暗色" />
  <img src="docs/screenshots/dialog-connection-light.png" width="49%" alt="新建连接 · 亮色" />
</p>

---

## 已实现能力

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
- **string 值操作栏**：位于值区上方（与右上角键级 ⋮ 菜单分工明确）。
  六个操作收在一个分段控件里 —— 编辑、复制、JSON 美化、自动换行、导出、刷新；
  「JSON 美化」与「自动换行」是常开的视图开关，常态下自己浮起，与动作类按钮一眼可分。
  自动换行关闭后长行横向滚动，便于比对长串；导出走主进程保存对话框；
  右侧显示字符数与行数
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
  修改与插入**共用弹窗** `EditListElementDialog.tsx`（`mode` 区分），二者形态一致：
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
  专用弹窗 `EditZsetMemberDialog.tsx`：member + score 双字段输入，
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
- **弹窗按钮图标**：底部操作栏的按钮统一在文字前加图标，由 `src/components/DialogIcon.tsx` 提供。
  图标按**语义**命名（`cancel` / `save` / `close` / `check` / `test` / `copy` / `add` / `edit` / `trash`）——
  调用方关心的是"这个按钮在做什么"，形状调整时不必回头改所有调用点。
  规格 16×16 viewBox、`stroke: currentColor`（跟随按钮文字色，主/次按钮上都能自动适配）、
  描边 1.5（比表格行内图标略粗，因弹窗按钮字号更大）。
  做成组件而非各处内联：同一套图标要出现在 12 个弹窗的 25 个按钮里，
  内联会把上百行重复路径散落到各文件
- **弹窗按钮圆角**：底部操作栏按钮使用胶囊形（`border-radius: 999px`）。
  12 个弹窗统一使用 `.dialog-foot`，规则集中定义在 `src/styles/main.css`。
  **选择器必须写足两个类**（`.dialog-foot button.btn`）：单靠 `body .dialog-foot button`
  与组件内的 `.btn` 规则同级比较时落败 —— **类选择器的权重高于元素**，
  加再多的 `body`/`button` 也换不来一个类权重，规则会被静默压过
  （页面无报错，只是圆角没变）。
  `ConfirmDialog` 的确认按钮用自定义类 `.confirm-btn`（不带 `.btn`），
  无法被上述规则覆盖，已在该组件内直接声明胶囊圆角。
  胶囊两端是弧线，同等的左右内边距视觉上更"紧"，故横向内边距略增补偿
- **弹窗拖动**：全部 12 个弹窗支持拖动 —— 按住**标题栏**移动窗口。
  由 `src/hooks/useDialogDrag.ts` 统一提供（`dragStyle` 绑 `.dialog`、`onDragStart` 绑 `.dialog-head`）。
  设计要点：位移用 `transform` 而非 `top/left`（不触发重排，也不与 flex 居中的初始定位冲突）；
  只由标题栏触发（内容区输入框与文本选择需要正常的鼠标划过）；
  按弹窗尺寸把位移钳制在视口内（否则拖出屏幕后按钮点不到）；
  拖动时给 `body` 加 `.dialog-dragging` 锁定光标并禁用选中。
  注意 `body` 类规则必须写在 `src/styles/main.css`，组件级样式文件不要声明挂到 `body` 的规则
- **stream entry 查看弹窗**：右键菜单首项「查看完整内容」，打开 `ViewStreamEntryDialog.tsx`。
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
- **排序指示用 SVG 三角形**（`src/components/SortIcon.tsx`），替代原来的 `⇅ / ↑ / ↓` 字符：
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
- **大 key 分页加载**：值区集合类型默认一次读 500 条（`VALUE_PAGE_SIZE`），单键最多累计
  20000 条（`VALUE_PAGE_MAX`）。hash / set 用 `HSCAN` / `SSCAN` 游标，list / zset 用偏移量，
  stream 用上一页最后一条 entry ID（含边界重读一条后丢弃，兼容旧版本）；
  底部「加载更多」显示已加载 / 总数。刷新当前键时按已加载数量重读，大 key 不会被重置回第一页；
  SCAN 跨页可能重复返回成员，set 合并时去重，hash 按字段名合并
- **Redis 键列表增量刷新**：工具栏刷新调用 `refreshKeys()`，以当前已加载数量为目标重扫当前匹配模式，
  结果回来才整体替换 —— 列表不清空、不闪骨架屏；未变化的键复用原对象引用，列表行不重绘；
  选中键不在新结果里时先用单键查询核实，确认已删除才清空值区（SCAN 本就不保证一次返回全部键）
- **值区虚拟滚动**：hash / list / set / zset / stream 五类表格接入 `VirtualRows`。
  行高由内容决定，逐行用 ResizeObserver 实测并缓存，前缀和 + 二分查找定位视口行，
  上下用等高占位块补足；行元素通过 `cloneElement` 注入 ref，不额外包一层 DOM，
  表格的 flex / grid 布局、hover 与粘性底栏完全不变。少于 40 行时全量渲染（窗口化开销大于收益）；
  string 的逐行行号视图由 `VirtualStringLines` 处理：不折行时固定行高精确虚拟化，
  折行时按估算高度 + 较大 overscan 保守渲染，行号始终存在

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
- **连接导入导出（JSON）**：侧栏头部的导入 / 导出按钮（transfer 图标）展开菜单，提供「导入连接… / 导出连接… / 从连接串导入…」，
  主页的「从连接串导入」按钮复用同一个弹窗。传输文件带独立格式头
  `{ format: "keyper.connections", version: 1, exportedAt, appVersion, includesCredentials }`，
  覆盖 Redis / Memcached 与多级 SSH 配置；导出固定为全量（v1 不做逐条勾选）。传输格式与内部
  `connections.json`（裸数组、与会话密钥绑定的 `enc2:` 密文）刻意分开 —— 后者换台机器就解不开。

  - **凭据默认不导出**：Redis 密码与 SSH 密码 / 私钥 / 口令默认剥离；勾选「包含凭据」需二次确认，
    并明确提示文件内是明文。条目按字段白名单构造：`pinned` 保留在内部配置但不写入传输文件，`credentialError` 仅运行时使用，两者都不随文件导出；
    保存了隧道但临时关闭的配置会显式写入 `sshEnabled: false`，避免导入端按「有 ssh 即启用」重新打开。
  - **导入预览**：读取文件后先逐条展示引擎、地址、库号 / TLS / SSH 跳板与凭据标签、
    与现有配置的 ID / 名称冲突、是否已连接，以及文件导出时间与应用版本；
    格式错误或不合法条目（端口越界、重复 ID 等）单列问题清单，**不阻塞其余合法条目**。
  - **合并策略**：默认一律新建 ID，重名自动追加 ` (2)`、` (3)`；可切换到「按 ID 覆盖」，
    覆盖时保留原有置顶标记；**已连接条目在覆盖模式下跳过** —— 只改磁盘配置不会重建内存会话，
    「界面显示新地址、实际仍连旧实例」比直接拒绝更危险。导入后原地更新连接列表，
    不重跑 bootstrap，已连接状态与已打开标签页不受影响。
  - **文件 IO 留在主进程**：渲染层只传选项，选择文件、读写与校验均在主进程完成；
    预览结果通过一次性令牌交给渲染层（5 分钟有效），渲染层不直接接触文件路径。
- **URI 批量导入**：同一弹窗内单条与批量两种模式。单条解析后显示掩码密码、库号与 TLS 状态，
  点「填入表单」带入新建连接弹窗；批量模式每行一个连接串，支持 `redis://`、`rediss://`、
  `memcached://` 与裸 `host[:port]`，`#` 注释与空行忽略，上限 200 行。
  逐行显示行号、引擎、地址、认证状态与错误原因（端口越界、Memcached 不支持认证 / 库号等），
  **只导入合法行**，并保留原始行号便于回查。
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
- **监控指标曲线**：Redis 概览的「监控」页签每 2 秒采样一次，最多保留 450 个点，
  支持 1m / 5m / 15m 三段窗口与暂停 / 清空；六项指标（内存、Ops/sec、客户端连接、命中率、
  键总数、淘汰数）各配一张自绘 SVG 折线图，并标出当前区间的最小 / 最大值。
  累计型计数器（淘汰数）按 60 秒窗口换算成每分钟增量，命中率按启动以来累计；
  页签与采样历史常驻，切走再切回不会从零开始。Memcached 详情页复用同一套采样与绘图骨架，
  只把数据源换成 `stats`：Ops/sec 由累计命令计数（get / set / touch / delete / incr / decr / cas）
  的相邻采样差值除以秒数得到，淘汰数同样按每分钟增量绘制
- **键空间通知**：概览的「键空间通知」页签可直接勾选 `notify-keyspace-events` 的
  频道位（K / E）与类型位（A、g$lshzxetd、m、n）并写回服务端，值预览随勾选实时拼接；
  A 是 g$lshzxetd 的别名，勾选 A 时具体类型显示为「隐含选中」。监听使用独立订阅连接
  （订阅模式下的连接不能执行普通命令，与 Pub/Sub 各自独立），只订 `keyevent` 频道 ——
  它与 `keyspace` 载荷互为镜像，两个都订会让一次操作推两条重复事件。
  事件流保留最近 200 条、自动滚到底部，可按事件名 / 键名 / 频道过滤；
  切换连接或离开概览页会退订，不留只收不推的幽灵连接
- **欢迎页**：无任何连接配置时，主区域展示本机运行环境（Electron / Chromium / Node / V8 / 平台）
  与 Redis 速查信息（默认端口、连接串格式、常用命令）
- **全局设置**：界面字号（12–16px，由 `--fs-base` 推导全套字号）、界面字体、代码字体、
  界面密度、每页加载键数、键名默认分隔符、删除前二次确认、日志保留天数，
  以及**主题、视图模式（树形/平铺）、CLI 展开状态、上次使用的连接与库、树节点展开状态**；
  持久化于配置文件 `settings.json`
  - **位置（便携模式）**：程序目录旁的 `config/`，整个文件夹拷走即可带走全部配置与日志。
    若程序目录不可写（如装在 `C:////////Program Files\` 下），自动回退到系统目录
    （Windows `%APPDATA%\\Keyper\`），并在设置界面如实标注回退原因
  - 也可用环境变量 `KEYPER_CONFIG_DIR` 指定任意目录
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
- **Memcached 批量操作**：键栏批量选择后，勾选操作条提供 TTL 修改、前缀重命名与批量删除，
  删除前走二次确认。值区切换为 `MemcachedBulkOpsPanel`（与 Redis 批量面板同骨架）：
  清单可搜索，可按键名 / TTL / 大小 / 状态排序，逐行显示当前值与目标值；
  执行时按清单顺序逐键调用 IPC，可随时中止；前缀重命名只改命中的键，
  目标键已存在时跳过并标记失败，不覆盖已有数据；
  任务结束后只广播一次键列表刷新，避免 N 个键触发 N 次全量枚举
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
- **全局提示（tooltip）**：项目**不使用原生 `title`**，统一走自绘的 tooltip。
  原生 tooltip 由系统绘制、延迟约 1 秒、样式不可控，暗色主题下会突兀地弹出一块亮色气泡。
  React 版把指令换成 `tipProps()` 展开到元素上（`src/components/tip.ts`），
  不新增 DOM 节点，全局唯一气泡由 `AppTooltip.tsx` 在 `App` 挂载一次：
  ```tsx
  <button {...tipProps('复制全部内容')}>…</button>          {/* 纯文本 */}
  <span {...tipProps(row.field)}>{row.field}</span>        {/* 动态文本 */}
  <button {...tipProps({ text: '重新读取该键', placement: 'bottom' })}>…</button>
  ```
  规则：**默认上方显示，空间不足自动翻转**；超过 40 字自动换行（`maxWidth: 320px`），
  短标签保持单行；水平方向钳制在视口内；滚动 / 缩放 / 点击 / 元素卸载时自动收起。
  定位算法由 `tests/unit` 与浏览器探针脚本覆盖。
  **嵌套绑定**（如页签内含关闭 ×）有专门处理：鼠标从子元素移回父元素时还原父级提示，
  而不是让提示就此消失 —— 指针从未离开父元素，父级的 `mouseenter` 不会重新触发。
  ⚠️ **`tipProps` 与 `title` 不可共存** —— 同时存在时浏览器仍会弹出系统提示，两个气泡重叠。
  另注意：`PromptDialog` 等组件上的 `title` 是**组件 prop**（弹窗标题），不是提示，不要误改。

**工程化与分发**

- **应用内更新**：打包版在主页「检查更新」面板走 electron-updater，检查 GitHub Releases 的
  `latest.yml`；有新版本时可直接下载并安装。下载走 blockmap 差分，只取与本地安装包不同的分块，
  进度由主进程推送到渲染层（百分比 / 已下载 / 总量 / 速度）；面板收起不中断下载，
  完成后可选「稍后」或「重启并安装」，选择稍后时退出应用自动安装。
  未打包版本没有 `app-update.yml`，自动更新直接跳过并回退到版本页检查
- **CI 与发布**：GitHub Actions 两个工作流 —— `ci.yml` 在每次 push / PR 上跑
  i18n 校验、类型检查、单元测试与构建；`release.yml` 响应 `v*` 标签（或手动运行），
  先校验标签与 `package.json` 版本一致，再在 Windows 上构建 NSIS，
  上传安装包、`latest.yml` 与 blockmap 并发布 Release。手动运行默认只构建、不发布
- **安装包精简**：Electron 运行时只打包 en-US / zh-CN / zh-TW 三个语言包（默认 50+ 种），
  渲染层依赖归入 devDependencies，asar 内只保留 ioredis / ssh2 / electron-updater 等生产依赖；
  安装包从 84.0 MB 降至 75.4 MB（-10.3%），app.asar 从 18.9 MiB 降至 3.7 MiB

## 安全说明

- 渲染进程开启 `contextIsolation`、关闭 `nodeIntegration`，仅通过白名单 IPC 访问主进程能力
- 连接密码优先调用系统钥匙串加密；仅在钥匙串不可用时降级为明文存储（以 `raw:` 前缀标记）
- 连接导出文件默认剥离凭据；显式勾选「包含凭据」后，Redis / SSH 密码、私钥与口令会以**明文**
  写入用户选择的文件，不做二次加密，需自行妥善保管
- 自动更新从配置的 GitHub Releases（HTTPS）拉取，安装包与增量元数据必须同源发布；
  Windows 安装包目前未做代码签名，正式分发前应补齐签名，避免 SmartScreen 告警
- 渲染进程启用 `sandbox: true`：preload 只保留 `require("electron")`，渲染层与 preload
  都拿不到 `require` / `process` / `module` / `Buffer`，能力仅经 contextBridge 暴露
- 渲染层加载严格 `Content-Security-Policy`（`default-src 'none'`，脚本/样式均不含
  `unsafe-inline`）：生产环境靠构建产物里的 `<meta>` 生效（`file://` 下响应头无效），
  开发环境由主进程注入带 HMR 放行的另一套策略。首屏主题脚本的 sha256 由
  `scripts/csp-hash.mjs` 在构建时自动写入，`npm run csp:check` 可校验是否失配
- 应用内导航、`<webview>` 挂载、Chromium 权限请求一律拒绝；外链交由系统浏览器打开，
  且只放行 https 与受信任域（GitHub）
