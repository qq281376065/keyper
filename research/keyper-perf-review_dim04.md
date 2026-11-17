# Keyper 性能审查 · 维度 04：构建产物、启动与资源管理

Route: C。

## 发现

### D4-1 渲染层单 chunk 1.53MB，无代码分割（中）
- dist/assets/index-Dwty79QG.js 1,530,053 B + index-D37dzd-g.css 346,455 B（实测 wc -c）。
- vite.config.ts build 段（L106-111）无 manualChunks、无动态 import；src/api/index.ts 静态 import mock.ts（2625 行）——**Electron 生产包也带着整套 mock 数据与逻辑**。
- 建议：mock 改 `await import('./mock')` 仅在 !bridge 时加载；ValueViewer/概览卡/Lua 弹窗等按路由级 React.lazy 分包；motion/radix 提独立 vendor chunk 利用缓存。Electron 本地加载收益小于 Web，但 mock 剔除与解析成本（V8 parse/compile 1.5MB）仍实在。

### D4-2 components.css 428KB 手写单文件（中，体积/维护）
- src/styles/components.css 428,436 B、14,875 行；大量 `.s-app.xxx, .s-app .xxx` 双形态选择器使规则近乎翻倍。构建后 CSS 346KB 全量进首帧。
- 建议：确认双形态是否仍有消费场景（Vue 迁移遗留），可裁一半；按组件拆分 + 关键 CSS 内联。属低风险大工程，优先级低于功能项。

### D4-3 启动路径已优化项（无需动）
- main.ts：show:false + backgroundColor + ready-to-show（L354-389）防白屏；sandbox:true；CSP hash 精确放行；启动仅 pruneOldLogs 一次同步目录操作。
- electron-builder.yml：语言包裁剪（注释：默认 50+ locale ≈41MB）、blockmap 增量更新、asar。
- 心跳/隧道：ssh keepaliveInterval 10s×3（ssh-tunnel.ts L121-123）；连接 probeTimer 在 disconnect/disconnectAll 均清理（stopProbe L449-454）。

### D4-4 隐藏标签常驻的内存成本（低，设计取舍）
- Workspace 非激活标签 display:none 不卸载（L80-82），键列表/值区/编辑器状态全保留 —— 这是「切换零重建」的产品决策，代价是多标签内存线性增长。值详情已用 Activity 缓解。可考虑对隐藏超过 N 分钟的标签释放值区大对象（保留键列表与滚动位置），属可选增强。

### D4-5 仓库遗留物（低，卫生）
- 工作树存在 nul、xargs.exe.stackdump、_lock-test.asar、.pack-tmp/ 等未跟踪文件；scripts/ 下 60+ 一次性探针脚本与交付代码混放。不影响运行性能，但影响仓库整洁与 CI 缓存命中。建议归入 .qa/ 或 gitignore。

## 置信度
体积数字为实测（wc -c）high；解析耗时收益推断 medium。