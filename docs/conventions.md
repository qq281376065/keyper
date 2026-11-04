# Keyper 开发规范与统一风格（强制清单）

> ⛔⛔ **项目基线（2026-11-04 用户明确）**：**后续任何 Keyper 需求，一律以本规范清单为基础。**
> 收到需求先读第 1 节红线、第 2 节代码硬约束、第 10 节 17 条检查清单，再定位代码、再动手。
> 优先级：用户当轮明确指令 > 本清单 > 其它记忆 / 历史惯例 / 技能默认流程。
> 与其它记忆冲突时以本清单 **加当前代码** 为准；发现滞后先报告，经确认才更新本文件。
>
> 整理于 2026-11-04，全部条目以**当前代码实测**为准（不是记忆转述）。
> 配套文档：`docs/architecture.md`（代码在哪）、`docs/development-pitfalls.md`（历史事故与坑因）、
> `docs/cultui-components.md`（Cult UI 组件库）。本文只讲**照着做什么、具体值是多少、怎么检查**。
>
> 注意：M6 Lua 运行器正在进行，`components.css`、tsconfig 等文件在被其它会话改动；
> 涉及行号与局部样式时以最新代码为准。本文不写版本号与命令清单（会漂移）。

## 1. 五条最高优先级红线

1. **简体中文**回复；思考过程也用中文。技术术语 / 命令 / 字段名可保留英文原词。
2. **一律不操作截图**：视觉核对只用 DOM 结构 dump、class/id 差异、CSS 层叠推导、
   结构化探针（jsdom / CDP 计算样式），需要几何数值时输出**文本**。
3. **交付闸门四条**：用户当轮没明确指令，就不跑全量测试、不改版本号、不打包发布、
   不擅自 commit/push。「提交」≠「推送」；「推送 git」≠ 升版本 / 全量测试 / 打包。
4. **最小爆炸半径**：点名组件是硬边界，不新建组件、不改 store、不顺手重构邻居；
   边界外发现只报不改；指错位置时先完整回滚上一处再改对。
5. **断言 / 测试粒度**：小改动（1–3 处样式值、调高度、换配色、移动元素）直接改完即止，
   不写断言不跑测试；新增模块 / 新机制 / 结构性重构才写断言 + 反证。

## 2. 代码级硬约束

### 2.1 新增功能的多处联动（漏一处静默坏）

| 新增内容 | 必改位置 |
| --- | --- |
| IPC 通道 | `shared/api.ts`（`RedisDesktopApi` 签名 + `IPC` 常量）→ `electron/preload.ts` → `electron/ipc/index.ts` → `src/api/mock.ts` → UI；要操作日志还得进 `LOG_ACTIONS` 并在 `describe()` 补参数下标；推送型另加广播与退订 |
| 会话状态字段 | `session.ts` 的 `RedisState` / `AppState` / `createSession` 初值 → `useRedis.ts` 的 `EMPTY_STATE` →（全局字段）`GLOBAL_KEYS` + `GlobalState` + `globals` |
| UI 文案 | `lang/en.ts` 加语义 key → `zh-CN.ts` / `zh-TW.ts` 同批 → 组件 `t()`；文案必须随**首个使用它的 UI** 落地 |
| 业务组件 | 根元素 `s-<kebab>` 类 → `components.css` 段注释 + 双命中选择器 → 新按钮类名登记 `main.css` 白名单 |
| 主题 / 皮肤 | 见第 5 节，共 6 处 |
| 测试 | `tests/unit/*.spec.ts`；electron 侧 spec 同步两处 tsconfig；DOM/hook 测试加 vitest jsdom glob |

### 2.2 i18n（由 `scripts/i18n-check.mjs` 强制）

- `lang/en.ts` 唯一事实来源并导出 `MsgKey`；另两份声明 `Record<MsgKey,string>`，编译期保证键集。
- 校验项：key 格式 `namespace.camelCase`；三字典键集一致（缺/多都报错）；
  占位符 `{name}` 集合一致；英文值不得残留中文（`locale.*` 例外）；译文须字符串字面量、
  无重复 key；`t()`/`tr()` 字面量 key 必须在目录中；**未被源码引用的 key 报错**。
  任一问题 `exit(1)`；扫 `src`/`shared`/`electron`，跳过 `mock.ts`。
- 运行时回退链：当前语言 → 英文 → key 本身。可保留英文：Redis/Memcached 专有名词、
  命令名、字段名、品牌名 Keyper；语言本名用本名不互译。
- 持久化操作日志仍存中文操作名（便于 grep），展示时才映射成 `MsgKey`。

### 2.3 样式与结构的硬约束

- **作用域双命中**：`.s-x.sel, .s-x .sel`（自身形态 + 后代形态），由
  `scripts/rescope-css.mjs` 与 `inject-scope.mjs` 配对生成；portal 到 body 的浮层要手工补作用域类。
  `src/components/ui/**` 走 Tailwind 原子类，**不走 `.s-*`**。
- **`@layer` 层序**：`theme → base → components → utilities`。覆盖 Tailwind 工具类
  （如 `.bg-white`）必须写在**所有 `@layer` 之外**；写进 `@layer components` 会被 utilities 静默压过。
  `main.css` 把 `button/input` 默认值包进 `@layer base`。
- **JSX 注释**：裸 `/* */` 会渲染成文本且构建不报错，特征指纹 `*/}/*`；
  `.s-x /* 注释 */` 后紧跟选择器会被 esbuild 拼成错误后代形态，注释必须独立成行。
- **标签隐藏**：用内联 `style={{display:'none'}}`，**不能用裸 `hidden` 属性**
  （UA 规则输给作者样式）；portal 浮层要订阅 `useTabBlur` 关闭。
- **`<Activity>` 保活**：隐藏→重显会重放 effect，新 effect 必须幂等；
  DOM 探针按 `offsetParent !== null` 过滤隐藏实例。
- **CSP 双通道**：`electron/main.ts` 的 `CSP_PROD` 与 `scripts/csp-hash.mjs` 的指令表
  必须手工同步；内联主题脚本改一字节都要重算哈希（生产禁 `unsafe-inline`）。
- **凭据**：`config/` 含加密凭据，绝不提交；导出连接默认剥离凭据；
  新增凭据字段必须显式加进加密白名单，不能用 `...item` 展开；
  改 `package.json` 等结构化配置禁止字符串替换，改完必须 JSON 解析校验。

### 2.4 双引擎对等

Memcached 逐项对齐 Redis：破坏性操作、删除图标、TTL、行高/悬停/选中态、右键菜单、
值区头部与工具条、加载与空态。**只能补齐，不得以「统一」为由删字段/入口/功能**；
确实要移除须先确认。计数位置、按钮形状、tooltip 等一律同 Redis。

## 3. 设计令牌（实测值）

| 组 | 变量与值 | 出处 |
| --- | --- | --- |
| 背景 5 级 | `#15171c` / `#1b1e25` / `#21252e` / `#272c37` / `#2f3542`（dark 默认） | `main.css` :root |
| 文字 3 级 | `#e6e9ef` / `#9aa4b8` / `#6b7488` | 同上 |
| 字号 | `--fs-base:13px`；10 档 calc 推导 → 8/9/10/11/12/13/14/16/22/24px | 同上 |
| 圆角 | `--radius-sm/md/lg = 4/6/10px` | 同上 |
| 行高 / 树行 | `--row-h:24px`；树形 `calc(var(--row-h)+2px)=26px` | 同上 / `components.css` |
| 行号槽 | `--gutter-pad-left:12px` / `-right:10px` / `--gutter-w: calc(12px+4ch+10px)` | 同上 |
| 面板阴影 | `--shadow-panel: 0 8px 24px rgba(0,0,0,.35)` | 同上 |
| 品牌 / CTA | `--brand-from:#CE3F33` / `--brand-to:#8A1A11`；`--cta-a/b/fg` 九套各配 | 同上 |
| 类型色 | 实际是 `--badge-*-fg/bg` 一组变量 + 组件内联注入的 `--vt-tc`（**没有** `--type-*` 分组） | `components.css` / `ValueViewer.tsx` |
| 卡面 | `--card-frame-bg`、`--card-face-bg`；hover 直接用全局 `--bg-hover`（**没有** `--card-cell-bg-hover`） | `tailwind-cards.css` |
| z-index | 无变量分组，字面量 70 / 71 / 9999 | `main.css` |

**注意三个易记错的点**：项目里没有 `--sp-*` 间距令牌、没有 `--card-cell-bg-hover`、
没有 z-index 变量分组，也不要给渐变/圆角硬编码新变量而不进主题块。

## 4. 组件统一风格（按控件）

| 控件 | 强制做法 | 具体值 / 出处 |
| --- | --- | --- |
| 按钮 | 胶囊，`main.css` 白名单 `999px !important` 集中收口，**不自写 border-radius** | 约 40 类 + `[class$='-btn']` 兜底 / `[class*='-btn ']`；`.dialog-foot button.btn` 必须双类选择器 |
| 按钮内图标 | `inline-flex` 居中、图标 `flex:0 0 auto; max-width:none`、不进 `align-items:baseline` 容器 | `.btn` gap 6px / padding 5px 12px；view-switch gap 4px；`.cta-animate > div` gap 8px |
| 按钮豁免 | 页签、抽屉把手、表单控件、引擎选择卡 | `.drawer-handle` 单独改 `var(--radius-md) 0 0 var(--radius-md)` |
| hover / 选中阴影 | 一律 `var(--lift-shadow)`，配 `transition: box-shadow .16s ease`；`:hover:not(:disabled)` | 定义见下 |
| tooltip | 一律 `{...tipProps(...)}`，**禁用原生 `title`**；已有统计卡/富浮层的元素不再挂 | `NOWRAP_LIMIT=40`、`maxWidth=320`、`GAP=8`、`EDGE=6`；placement 仅 4 向；`refreshTip` 用于动态文案；嵌套绑定由 WeakMap 还原父提示 |
| 图标 | 只用 `DialogIcon` 语义名（75 个），禁 emoji / 特殊符号；业务组件不用 lucide | 16×16 viewBox、`currentColor`、描边 1.5、默认 size 13；新增图标改类型联合 + `renderGlyph` 两处 |
| 弹窗 | 套 `DialogShell`：header（图标+标题+副标题+badge+关闭）→ 常驻 notice → 滚动 body → 固定 footer；头部可拖拽 | 遮罩**默认不可关**（`closeOnOverlay=false`），只有 `ConfirmDialog` 例外；宽度档 440/460/520/560/600/620/680/720/760 + `max-width:calc(100vw - 40px)` |
| 关闭按钮 | `dlg-close` + `cancel` 图标，hover 红圆 | `#dc2626`（深）/ `#e11d48`（浅） |
| 破坏性操作 | `askConfirm` 统一结构，尊重 `settings.confirmDelete`，不可逆加 `requirePhrase` | `title/message/description/confirmText/details/preview/warning/requirePhrase/compact/danger/force` |
| 菜单 | `popover-mask` + 按实际高度落位夹视口 | 页签右键：刷新 / 关闭 / 关其他 / 关右侧 |
| 页签 | 首项主页固定不可关闭；溢出才出左右箭头与 ⋯ 更多面板；激活标签滚入可见区 | `TabBar` |
| 分段控件 | 999px 胶囊凹槽 + 独立选项胶囊；同组每个选项图标必须不同 | `components.css` |
| 开关 / 计数 | 通用开关用 `SwitchRow`（label 整行可点 + useId）；「可见/总数」计数只能是筛选框 `trailing` 槽的纯文字 `.counter mono` | 不要胶囊背景、不要挪到标题旁 |
| 卡片 | 卡面跟随皮肤；九宫格/信息卡默认透明、浅色虚线、hover 用全局 `--bg-hover` | 九宫格每条只画右+下 `1px dashed var(--border)`，外圈用 nth-child 去掉；3/2/1 列各一套规则 |
| 空态 / 加载态 | 每个列表/面板都要有空态、加载态、无匹配态 | `FavoritesPanel` / `SearchFilterBox` |
| 类型徽标 | 全局 18px 圆形 / 11px 字母；三个对话框内的胶囊版是历史例外，不要误改 | 键列表字母映射 S/H/L/E/Z/X/? |
| 品牌文字 | 项目名纯文字、不加粗；只有 Logo 与顶栏图标保留投影 + 悬停上浮 | 像素字体合成加粗会糊 |

### hover / 选中阴影的精确定义

```css
--lift-shadow:
  0 1px 1px rgb(var(--shadow-ink) / var(--lift-a1)),
  0 2px 3px -1px rgb(var(--shadow-ink) / var(--lift-a2));
```

`--shadow-ink` 暗色 `0 0 0` / 亮色 `15 23 42`；`--lift-a1/a2` 暗色 `.30/.345`、
亮色 `.13/.19`（ocean/forest 同暗色）。**必须使用**：页签 hover/active、连接磁贴、
DB 工具条 mini、`.btn-ghost.icon`、`.dlg-close`、`.more-btn`、`.add-btn`、
`.rail-toggle`、`.tabbar-btn`、`.bar-btn`、`.win-btn`、`.del-btn`、`.row-act`、`.op`、
`.hp-del`、`.s-theme-switch .trigger`、`.flyout-close`；选中态再叠
`inset 0 0 0 1px var(--accent)`。**明确排除**：`.ov-refresh`、`.hp-clear`、`.f-clear`、`.s-clear`。
共 11 处 `prefers-reduced-motion` 兜底。

## 5. 主题与皮肤

9 套：dark（默认）、light、ocean、solarized、forest、sakura、mint、mist、aurora，
判定用 `<html data-theme>`。`index.html` 的 SCHEME 首帧脚本防闪烁（只列 7 套，
dark/light 走 system 分支），持久化 key `keyper:theme`（兼容旧 `redisdocter:theme`）。
Tailwind 的 `@custom-variant dark` **只认 dark / ocean / forest 三套暗色**。

**新增皮肤必须同批改 6 处**：`main.css` 变量块 → `index.html` SCHEME →
`src/services/theme.ts` 的 `SkinId` 与 `SKIN_SCHEME` → `tailwind.css` dark 变体（暗色系）→
`tailwind-cards.css` 三组选择器 → `main.css` 亮色磁贴阴影组（亮色系）。
漏一处就会退回纯白卡面。

## 6. 布局与密度

- 分隔线统一 `1px solid var(--border)`；九宫格用 `1px dashed var(--border)`。
- 滚动条 10px，thumb 圆角 6px + 2px 透明边 + `background-clip:padding-box`。
- 拖拽态：`body.col-resizing` / `body.dialog-dragging` 全局禁选中与拖拽；
  `.v-splitter` 8px、`.drawer-handle` 三形态。
- 弹窗宽度按第 4 节档位取，不自造尺寸；所有弹窗带 `max-width:calc(100vw - 40px)`。
- CTA 主按钮 48px / 次按钮 34px；`.mini` 22×20px；`.type-badge` 18px；`.engine-chip` 14px。

## 7. 交付与验证流程

1. 一轮改动做完、验证过了，**一次提交**（不按层/按文件拆）。
2. 默认闸口：`npm run typecheck`（web + node 两工程）+ `i18n:check` + 被改动目标的单测；
   UI 改动再补 `dev:web` 的 DOM / 计算样式 / 控制台证据。不跑全量套件。
3. 大功能先建 feature 分支、先给方案（D1…Dn 决策点）与接口契约清单，确认后才写实现；
   UI 开放题先出多方案 HTML 预览，条目式小改直接做。
4. 每轮以文字结论收尾（实测数据 + 未提交说明）。
5. 发版：本地 `master` → `git push github HEAD:main`；**标签推上去后绝不能再动**
   （删/强推/移动 → Release 降级草稿、下载直链恒 404）；发版说明落两处
   `release-notes.md`；同版本重打用 `dist:win:alt`。详见 `development-pitfalls.md` 第 6 节。

## 8. 校验脚本即硬约束

| 脚本 | 断言内容 |
| --- | --- |
| `scripts/check-lift-shadow.mjs` | 选中态 = inset 1px 描边 + 近影 `0 1px 1px` + 远影 `0 2px 3px -1px` 共 3 层；未选中无影；阴影余量 ≥4px；L1/L2 互斥；`.tab.active` 与 `.mini.on` 阴影逐字同源 |
| `scripts/check-tab-lift.mjs` | 方案 01 hover 只加影不位移、按下收影；方案 09 hover 上浮 1px、按下回 0；必须用 CDP 真触发 `:hover`；两方案手型光标、静态方案 03 默认 |
| `scripts/csp-hash.mjs` | 指令表与 `main.ts` 的 `CSP_PROD` 一致；`--check` 下 hash 失配即退出 1；生产禁 `unsafe-inline` |
| `scripts/i18n-check.mjs` | 第 2.2 节的 7 类检查 |
| `scripts/check-style-conventions.mjs` | 源码级守护（`npm run style:check`，已进 CI）：`--lift-shadow` 双层几何与 9 套 alpha、999px 胶囊白名单、按钮选中态 inset + 外影、组件不硬编码浮起几何、`.bg-white` 覆盖在 `@layer` 之外。零依赖、不启浏览器 |
| `tests/e2e/smoke.mjs` | 最小 e2e（`npm run test:e2e`，已进 CI）：自包含启动 vite web 与无头 Chrome，6 条 CDP/DOM 冒烟（启动 / mock 连接 / 六类值 / 切标签隔离 / 删除确认 / 主题切换），不截图 |

前两个脚本均声明**不截图**，只用 DOM / 计算样式断言 —— 与红线一致。
但它们是**开发期探针**：硬编码本机 Chrome 路径、依赖本地预览服务（`check-tab-lift`
还依赖已停止跟踪的 `design/` 页面），因此不进 Ubuntu CI。CI 里的源码级断言由
`check-style-conventions.mjs` 承担，真实渲染效果仍靠这两个探针在本地验。
e2e 用 `CHROME_PATH` 指向系统 Chrome（CI 为 `/usr/bin/google-chrome`），
本机自动扫描 Playwright 缓存里的 Chromium。

## 9. 易混淆 / 不适用

- **antyman 项目的 antd 规范不适用于 Keyper**：`shape="round"` + 图标、表单 label 同行、
  数据库逻辑收进 Model 等属于另一仓库；Keyper 是纯 CSS 胶囊 + `DialogIcon`。
- 2026-10-27 之前日志里的 `.vue` / `App.vue` / `ValueViewer.vue` 路径已失效。
- `.qoder-cn` 是 Qoder 侧记忆，`.workbuddy/memory` 是 WorkBuddy 侧，不要混写。
- 原生 `title` 的**已知例外**：`ErrorBoundary` 的多行堆栈详情、
  `StreamAdminPanel` 两处；`DialogShell` / `PromptDialog` 的 `title` 是**组件 prop**（弹窗标题），
  不是 tooltip，不要误改。
- 「不改 vendor」这条在本仓库代码中查不到依据，属于跨项目习惯，不列为本项目硬约束。
- `.gitignore` 影响新增文件：`design/`、`scripts/`（**新增要保留的脚本必须 `git add -f`**）、
  `release-notes.md`（不带斜杠，根目录与 `build/` 同时覆盖）、`config/`、`site/`、
  `.qa/`、`previews/` 等。

## 10. 新增组件 / 新功能检查清单

```
[ ] 文案：en.ts 加语义 key，zh-CN / zh-TW 同批；跑 i18n:check
[ ] 提示：只用 tipProps，删净原生 title；已有统计卡/富浮层不重复挂
[ ] 图标：DialogIcon 语义名；禁 emoji / lucide（ui 原子件内部除外）
[ ] 按钮：胶囊靠全局白名单，新类名登记 main.css；图标 flex 不收缩
[ ] 阴影：hover/选中只用 --lift-shadow，带 :hover:not(:disabled) 与过渡
[ ] 弹窗：套 DialogShell（header/notice/body/footer），遮罩默认不可关
[ ] 关闭：dlg-close + cancel 图标，复用红圆 hover
[ ] 破坏性：askConfirm + confirmDelete；不可逆加 requirePhrase
[ ] 菜单：popover-mask + 按实际高度落位夹视口
[ ] 状态：空态 / 加载态 / 无匹配齐备；计数只放筛选框 trailing 纯文字
[ ] 样式：新组件 s-<kebab> 根类 + 双命中选择器；覆盖 Tailwind 写在 @layer 之外
[ ] 主题：9 套皮肤下颜色来自变量，不硬编码；新增皮肤 6 处齐改
[ ] 双引擎：Memcached 侧同步补齐，不删减内容
[ ] IPC：shared/api → preload → ipc → mock → UI 五处联动
[ ] 验证：typecheck + i18n:check + 目标单测 + dev:web DOM 证据；不跑全量、不截图
[ ] 交付：等明确指令才 commit / push；不升版本、不打包
```
