# Cult UI 组件速查（Keyper）

> 整理于 2026-11-04。事实来源：`cult-ui.com` 官网 / sitemap / registry JSON、
> 本仓库 `components.json` 与 `src/components/ui/` 源码、`docs/pixel-heading.md`。
> 与 `docs/architecture.md`（代码在哪）、`docs/development-pitfalls.md`（别踩什么）配套。
>
> 官网数字与可枚举清单不一致时如实标注：**首页口径 154 个动画组件**，
> `sitemap.xml` 里 `/docs/components/<slug>` 页面 **134 个**（2026-11-04 提取）。
> 引入某个组件前，先用 `https://cult-ui.com/r/<slug>.json` 验证它真实存在。

## 1. 它是什么，项目怎么接进来的

Cult UI 是 **shadcn/ui 的动效组件扩展**（MIT，Nolly Studio 维护），不是 npm 依赖，
而是像 shadcn 一样**把源码复制进项目**。本仓库 `components.json` 已注册：

```json
"registries": { "@cult-ui": "https://cult-ui.com/r/{name}.json" },
"aliases": { "ui": "@/components/ui", "utils": "@/lib/utils", "hooks": "@/hooks" },
"style": "new-york", "iconLibrary": "lucide", "tailwind.css": "src/styles/tailwind.css"
```

安装命令格式：`npx shadcn@latest add @cult-ui/<slug>`。
⚠️ 本机 `npm`/`npx` 不在 Git Bash PATH，实际要用 Qianwen node 跑 CLI；
且 CLI 会直接写 `src/components/ui/`、可能改写 `tailwind.css` 与依赖，
**执行前先确认影响面**，不要当成无害的复制命令。

registry JSON 结构（抽查 `halo-button.json` 确认）：`$schema` / `name` / `type: registry:ui` /
`description` / `dependencies` / `files[{path, content, type}]`。
`dependencies` 会带第三方包 —— 例如 `halo-button` 依赖 **`@base-ui/react` + `motion`**，
而项目只装了 `motion` 与 `radix-ui`，**没有 `@base-ui/react`**。这是引入新组件的第一道闸门。

**项目当前落地 10 个 ui 文件**（`src/components/ui/`，共 1907 行）：

- 7 个 shadcn 风格原子件：`button` / `input` / `label` / `textarea` / `select` / `switch` / `dialog`
- 3 个 Cult UI 重动效件：`bg-animate-button` / `expandable` / `pixel-heading-character`

引用分布：23 个组件文件用到 `@/components/ui/`，主要集中在弹窗层
（`ConnectionDialog`、`CreateKeyDialog`、`EditHashFieldDialog`、`SettingsDialog`、
`DialogShell`、`ConfirmDialog`、`SwitchRow`）；三个 Cult 件只在主页 `WelcomePanel`
与标题预览页 `src/preview/HomeTitleOptions.tsx`。

## 2. 官方组件全景

按用途归类（括号内为代表 slug，完整清单见附录）：

| 类别 | 代表组件 | 与 Keyper 的潜在关系 |
| --- | --- | --- |
| 按钮 | `bg-animate-button`（**已落地**）、`halo-button`、`border-beam-button`、`cosmic-button`、`metal-button`、`organic-button`、`texture-button`、`family-button`、`gradient-button-group` | CTA、工具条主操作；注意胶囊 999px 规范 |
| 卡片 | `expandable`（**已落地**）、`shadow-card`、`folded-card`、`cutout-card`、`organic-card`、`minimal-card`、`shift-card`、`fluted-glass`、`merging-bubbles`、`illustration-card-grid` | 主页卡片、概览卡、空态 |
| 背景/纹理 | `bg-animated-fractal-grid`、`bg-media`、`bg-image-texture`、`grid-beam`、`stripe-bg-guides`、`dither-image`、`hero-*` 系列 | 欢迎页与面板背景；注意 9 套皮肤对比度 |
| 文字/标题 | `pixel-heading-character`（**已落地**）、`pixel-heading-word`、`gradient-heading`、`text-animate`、`typewriter`、`rolling-number`、`pixel-paragraph-words` | 主页标题、指标数字 |
| 导航/标签 | `direction-aware-tabs`、`dock`、`side-panel`、`halo-tabs`、`halo-segmented`、`toolbar-expandable`、`wizard-expandable` | 值区二级页签、分段控件、侧栏 |
| 输入/表单 | `halo-input`、`halo-select`、`halo-switch`、`halo-field`、`halo-search`、`prompt-composer`、`border-beam-input`、`color-picker`、`copy-button` | 连接弹窗、CLI、搜索框 |
| 反馈/状态 | `halo-toast`、`halo-notification`、`halo-progress`、`halo-badge`、`intro-disclosure`、`popover`、`popover-form`、`timer`、`loading-carousel` | 操作结果、确认提示、加载态 |
| 数据展示 | `analytics-chart`、`kanban-board`、`code-block`、`file-icons`、`sortable-list`、`tweet-grid`、`vote-tally` | 监控图表、慢查询、键列表 |
| 设备/插画 | `dynamic-island`、`globe`、`mac-screen`、`apple-*`、`mock-browser-window`、`illustration-*` | 欢迎页视觉、关于页 |
| 组合/其他 | `onboarding`、`feature-carousel`、`feature-sticky-section`、`three-d-carousel`、`security-checkpoint`、`collab-toolbar`、`speech-bubble` | 引导流、特性展示 |

⚠️ 越靠「动效/插画」的组件越可能带硬编码颜色、额外依赖与 `@base-ui/react`，
与本项目 9 套皮肤、无 Preflight 的约束冲突最大；优先挑 **halo-\*** 这类纯交互件。

## 3. 项目内组件 API 速查

**原子件（7 个）**：全部基于 `cn()`（`src/lib/utils.ts` = `twMerge(clsx(...))`）+ Tailwind v4 原子类，
`React 19` 直接透传 ref（无 forwardRef）。

| 文件 | 导出 | 关键 Props / 变体 | 依赖 | 备注 |
| --- | --- | --- | --- | --- |
| `button.tsx` | `Button`, `buttonVariants` | `variant`: default/destructive/outline/secondary/ghost/link；`size`: default/xs/sm/lg/icon/icon-*；`asChild` | `radix-ui` 的 `Slot.Root`、cva | 带 `data-slot` 属性 |
| `input.tsx` | `Input` | 原生 input props | — | `focus-visible:ring` |
| `label.tsx` | `Label` | 原生 label props | `LabelPrimitive.Root` | `peer-disabled` 联动 |
| `textarea.tsx` | `Textarea` | `autoGrow?: boolean`（默认 false） | `useAutoGrow`（ResizeObserver 观察父宽） | `field-sizing-content` |
| `switch.tsx` | `Switch` | `size`: sm/default；Radix `checked/onCheckedChange` | `radix-ui` | Thumb 用 transform 位移 |
| `select.tsx` | 11 个子件 | `SelectContent` 默认 `position="item-aligned"` / `align="center"` | Radix Portal、lucide | 见第 7 节「死动画类」 |
| `dialog.tsx` | 10 个子件 | `DialogContent.showCloseButton=true`、`DialogFooter.showCloseButton=false` | Radix Portal/Overlay、lucide | `bg-black/50` 遮罩 |

**Cult UI 三件（重点）**

`pixel-heading-character.tsx`（638 行）：导出 `PixelHeading` / `PixelHeadingMode` / `PixelHeadingProps`。
`extractText` 抽 children 文本后**逐字渲染 `<span>`**；`PIXEL_FONTS` 五套字体按
`uniform` / `multi`（黄金比 PHI）/ `wave` / `random`（Knuth 哈希）分配；`TICK_MS=50` 的
`setInterval` 驱动，但逐字换字体**直接写 `el.className` 不走 setState**（只有 uniform 用 setState）。
可配 `as` / `cycleInterval=150` / `defaultFontIndex` / `onFontIndexChange` / `showLabel` /
`mode` / `staggerDelay` / `autoPlay=false` / `prefix` / `prefixFont` / `isolate`；
订阅 `prefers-reduced-motion` 并停表，支持 Enter/Space 触发。
字体来自 `geist` 包，但 `geist/font/pixel` 是 Next.js `localFont`，Vite 下会报错 ——
项目在 `src/styles/geist-pixel.css` 手写 5 个 `@font-face`，变量再经 `tailwind.css`
的 `@theme inline` 注册为 `--font-pixel-*`，并用 `@utility font-pixel-*` 兜底。
渐变标题靠 `.px-title span{color:transparent}` + `background-clip:text` + `@keyframes px-sweep`。

`expandable.tsx`（553 行）：导出 `Expandable` / `useExpandable` / `ExpandableCard` /
`ExpandableContent` / `ExpandableContext` / `ExpandableTrigger` / `ExpandableCardHeader` /
`ExpandableCardContent` / `ExpandableCardFooter`，全部 `forwardRef`。
`Expandable` 支持受控（`expanded` / `onToggle`）；Context 传
`expandDirection/expandBehavior/transitionDuration=0.3/easeType/initialDelay`。
动效全靠 `motion/react`（AnimatePresence、useMotionValue、useSpring，spring 200/20/0.2）
+ `react-use-measure`（ResizeObserver）；`ANIMATION_PRESETS` 10 种（fade/slide/scale/rotate/blur）。
**卡片四层**：尺寸容器（内联固定 width/height）→ ① `md:rounded-[2rem] ring-1` 外框
→ ② `md:p-2` 8px 留白 → ③ `md:rounded-3xl md:p-4 bg-white dark:bg-muted` 内容面
→ 内层 `h-full overflow-hidden` + measureRef。`hoverToExpand` 用 setTimeout 触发。
`WelcomePanel.tsx` 的 `ShellCard` 用 `<Expandable expanded expandBehavior="push" transitionDuration={0.28}>`
包 `<ExpandableCard className="feat-card">`，主页现有两张卡（功能九宫格 / 底部信息卡）。

`bg-animate-button.tsx`（199 行）：唯一同时 `forwardRef` + `asChild` 的 Cult 件，
`Slot` 来自 **`@radix-ui/react-slot`**（与 button.tsx 的 `radix-ui` 聚合包不同）。
Props `UnifiedButtonProps`：`variant/size/shadow/rounded/asChild/showBackground/animation/gradient`；
三个 cva（outerDiv / innerSpan / buttonVariants），`animation` 支持 pulse/spin/spin-fast/spin-slow/spin，
`gradient` 8 套（ocean/candy/forest/sunset/nebula 等是**硬编码 hex**），
`theme` 渐变走 `THEME_CONIC` 读 `var(--cta-a)/var(--cta-b)`，文字色 `var(--cta-fg)`，
由 `main.css` 九套皮肤各配一份。动画是 `inset-[-1000%]` 的旋转渐变 span + `animate-[spin_4s_linear_infinite]`。
⚠️ cva 里 `defaultVariants.gradient=forest`，但函数签名又默认 `null` —— **不传 gradient 就没有渐变层**。

## 4. 主题与样式接线（引入新组件前必读）

- `src/main.tsx` 加载顺序：`main.css` → `components.css` → `tailwind.css`。
- `tailwind.css` 声明 `@layer theme, base, components, utilities`，只 import
  `theme.css`/`utilities.css`，**刻意关闭 Preflight**；`@theme inline` 把 shadcn 语义名
  映射到应用变量（`--bg-app` / `--accent` / `--card` …）；`@custom-variant dark`
  重绑到 `[data-theme='dark'|'ocean'|'forest']`（只认这 3 套暗色）。
- `main.css` 把 `button/input` 元素默认值包进 `@layer base`，否则会压过 utilities；
  `--lift-shadow` / `--lift-a1/a2` 与 9 套主题也在这里；按钮胶囊白名单 `999px !important` 同文件。
- `tailwind-cards.css` 专门给这套组件打补丁：`.cta-animate{padding:0}`（补 Preflight 缺失的
  button padding，否则双层圆角不同心露底色）、`> div{inline-flex}`（修 SVG 基线偏移）、
  `prefers-reduced-motion` 停旋转、`.feat-card .bg-white` 覆盖写在**所有 `@layer` 之外**
  （utilities 会压过 components 层的覆盖）。
- 关键区别：`src/components/ui/**` 走 **Tailwind 原子类**，不受 `.s-<组件>` 作用域规则约束；
  手写 CSS 的 70+ 业务组件才走 `.s-*` 双命中。两套体系不要混用选择器思路。

## 5. 引入新组件的固定流程

1. 在附录清单里选 slug → 用 `https://cult-ui.com/r/<slug>.json` 验证存在，读 `dependencies`
   与 `files[].path`，确认要落到哪个 alias 目录。
2. **依赖闸门**：`motion` / `radix-ui` / `lucide-react` / `react-use-measure` 已有；
   `@base-ui/react`、`tw-animate-css` 等没有 —— 需要新增依赖时先向用户确认，不要静默 `npm install`。
3. 落源码到 `src/components/ui/<slug>.tsx`；`cn()` 用现成的 `@/lib/utils`。
4. **主题适配**：把组件里的语义 token 映射到项目变量，补齐 9 套皮肤；
   `dark:` 变体只覆盖 3 套暗色，浅色皮肤要单独看。
5. **对齐 Keyper 规范**：按钮胶囊 999px（新类名进 `main.css` 白名单）、hover/选中用
   `--lift-shadow`、图标用 `DialogIcon`、提示一律 `tipProps` 禁原生 `title`、
   所有 UI 文案走 `lang/en.ts` + zh-CN/zh-TW 三份字典（且必须随首个使用它的 UI 同批落地）。
6. 验证：`npm run typecheck`（两工程）+ `i18n:check` + 对应单测 + `dev:web` 的
   DOM / 计算样式 / 控制台证据。**不跑全量套件**，除非用户点名。
7. 等明确指令才提交 / 推送；UI 开放题先出多方案 HTML 预览再改真实代码。

## 6. 坑位清单（均基于本仓库源码事实）

1. **无 Preflight 的基线与居中塌陷**：`button` 带 UA `padding:1px 6px`，
   `bg-animate-button` 双层圆角不同心、旋转时露深带；SVG 按基线排导致图标偏上 1.5px。
   补丁都在 `tailwind-cards.css`，删掉即复现。
2. **`@layer` 顺序吞覆盖**：`.bg-white` 属 utilities，任何写在 components 层的同名覆盖
   都会被静默忽略；`tailwind-cards.css` 的卡面规则必须在层外。
3. **进出场动画类是死类**：`dialog.tsx` / `select.tsx` 里的
   `animate-in` / `fade-in-0` / `zoom-in-95` / `slide-in-from-*` 全库无定义，
   也没装 `tw-animate-css` —— 目前弹窗/下拉只有 `duration-200` transition，复制即失效。
4. **主题变量缺一即变白**：`--cta-a/b/fg` 必须 9 套皮肤都配；
   `--font-geist-pixel-*` 五个变量缺一个整字回退 monospace；
   `--color-destructive` 现在竟映射到 `var(--accent)`，危险态不是红色。
5. **Slot 双版本**：`button.tsx` 用 `radix-ui` 的 `Slot.Root`，
   `bg-animate-button.tsx` 用 `@radix-ui/react-slot` 的 `Slot`；后者 `asChild`
   会合并 ref/className 到子元素，内部又渲染固定 div，嵌套 Slot 易出双事件/双 ref。
6. **expandable 高度**：`measuredHeight` 初值 0、`collapsedSize.height` 内联固定，
   内容变高必须靠 `tailwind-cards.css` 的 `height:100% !important` 兜底，否则溢出。
7. **Cult 件普遍硬编码颜色**：8 套 gradient 是 hex、卡片圆角/阴影写死在类名里，
   与「跟随皮肤」定案冲突，引入后要逐项改造成变量。

## 7. 本地已有资源索引

| 路径 | 内容 |
| --- | --- |
| `docs/pixel-heading.md` | 254 行英文，PixelHeading 的落地记录、字体接线、Ember Duotone 方案、几何验证 |
| `components.json` | shadcn 配置与 `@cult-ui` registry 注册 |
| `design/cta-10-cultui.html`、`design/cta-5-schemes.html` | CTA 按钮方案预览（未跟踪） |
| `design/key-info-cultui-27-schemes.html` | 值区 key-info 的 27 套 Cult UI 风格方案（未跟踪） |
| `previews/home-title-options.html`、`src/preview/HomeTitleOptions.tsx` | PixelHeading 调参预览页 |
| `scripts/verify-title-interaction.cjs`、`.qa/cultui-preview.cjs` | 标题交互 / Cult UI 预览探针 |
| `README.md:698-706` | 「新建连接」段落说明 Cult UI 原子组件与 9 套皮肤 |

## 附录：sitemap 收录的 134 个组件 slug（2026-11-04）

```text
agent-suggest-card-stack  ai-blob-warp  ai-instructions  analytics-chart
apple-iphone-17-pro  apple-keyboard  apple-pro-display-xdr  apple-watch-ultra
bg-animate-button  bg-animated-fractal-grid  bg-image-texture  bg-media
border-beam-button  border-beam-card  border-beam-input  canvas-fractal-grid
choice-poll  circuit-board  code-block  collab-avatar  collab-toolbar
color-picker  copy-button  cosmic-button  cutout-card  direction-aware-tabs
distorted-glass  dither-image  dock  dynamic-island  edge-blur  expandable
expandable-screen  family-button  family-drawer  feature-carousel  feature-poll
feature-sticky-section  feature-voting  file-icons  floating-panel
fluid-ai-workloads  fluted-glass  folded-card  gateway-endpoint-illustration
gateway-route-illustration  gateway-svg-illustration  globe
gradient-button-group  gradient-heading  grid-beam  halo-badge  halo-button
halo-card  halo-dropzone  halo-field  halo-input  halo-notification
halo-progress  halo-search  halo-segmented  halo-select  halo-switch
halo-tabs  halo-toast  halo-toggle-group  hero-color-panels  hero-dithering
hero-heatmap  hero-liquid-metal  hero-static-radial-gradient  hover-video-player
illustration-card-grid  illustration-comment-bubble  illustration-cursor
illustration-fluid-rendering  illustration-globe-vercel  illustration-graph
intro-disclosure  kanban-board  lightboard  loading-carousel  logo-carousel
mac-screen  marketing-feature-code  marketing-hero-analytics  merging-bubbles
metal-button  minimal-card  mock-browser-window  morph-surface  neumorph-button
neumorph-eyebrow  onboarding  organic-button  organic-card  organic-card-small
pixel-heading-character  pixel-heading-word  pixel-paragraph-words
pixel-paragraph-words-inverse  poll-widget  popover  popover-form
prompt-composer  prompt-library  rolling-number  security-checkpoint
shader-lens-blur  shadow-card  shift-card  side-panel  sortable-list
speech-bubble  squiggle-arrow  stripe-bg-guides  svg-bands  svg-shapes
svg-shapes-animated  tabs-illustration-vercel  terminal-animation  text-animate
text-gif  texture-button  texture-card  texture-overlay  three-d-carousel
timer  toolbar-expandable  tweet-grid  typewriter  vote-tally
wizard-expandable  youtube-video-player
```

> 官网首页口径 154 个（含 58 个新组件），与 sitemap 134 个的差异未逐一核对；
> 以 registry URL 是否返回有效 JSON 为最终判据。
