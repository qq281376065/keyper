# Keyper 性能优化实施验证报告（phase1 + phase2）

日期：2026-11-17 · 基线：v1.1.4（38ef06d）
分支：`perf/optimize-review`（phase1，已合并 master ac8dfd7）→ `perf/optimize-phase2`（phase2）

## 一、实施清单与提交

### phase1（perf/optimize-review → master ac8dfd7）

| 提交 | 内容 |
|---|---|
| 8507e13 | GitHub 仓库入口：品牌区版本号后图标 + 主页「源码仓库」按钮 |
| fb6e5f4 | P0 主进程护栏：string 大值 STRLEN+GETRANGE 分段（2MB 首屏/续读，UTF-8 边界安全，whole 整读 32MB 硬上限）；valueBinary 限量取回；gzip/zlib 异步解压；setValue MULTI 原子整写+分片+stream 批量 XADD；7 处微操作 pipeline 合并（RENAMENX 保防覆盖）；INFO Map 解析；心跳定时器清理；搜索进度 150ms 节流 |
| 12c7538 | 批量通道下沉主进程（redis:bulk/bulkCancel/bulkProgress 全链），千键任务 1000×IPC→1 次；保留逐键失败明细/取消令牌/列表同步；日志每任务一条汇总；mock 同构 |
| 3f69268 | 日志异步追加队列+退出 flush；错误日志 prune 每日一次；settings 进程内缓存；Memcached 收包 O(n²)→O(n)（chunk 链表+双阈值合并+扫描偏移记忆） |
| 96a651b | store batch 合并广播；prettyJson/utf8Bytes memo；loadAll 整批赋值；Intl.Collator 复用；Pub/Sub 与键空间消息 rAF 合帧；Slowlog 双定时器合并；生产包剔除 mock（JS 1530KB→1483KB 实测） |
| 6a93bf5 | 组件化：ValueViewer 2913→2682 行、KeyBrowser 1759→1672 行、MemcachedKeyBrowser 1437→1227 行，拆出 ValueDialogs/ValueViewerBits/KeyContextMenu/McTreeRow 四文件（726 行），只搬渲染不搬状态 |
| 14b76b2 | 27 真实 Redis 集成测试 + 10 渲染层单测；**修复 LINSERT 哨兵还原下标历史 bug**（BEFORE 插入后哨兵后移一位，原固定 index 还原会覆盖新值并残留哨兵）；deleteListElement 同步改 MULTI |

### phase2（perf/optimize-phase2）

| 提交 | 内容 |
|---|---|
| 48456e7 | Context API 缓存：Workspace makeSessionApi 按 session 身份 useMemo（null→对象/会话替换自然重建，不锁旧 null）；同一会话重渲染不再重建 ~40 个 bind 与 Context value |
| 167fa5e | 字段级订阅：store 顶层字段独立版本（深层写入归并根字段，batch 退出合并递增）；useSessionFields(fields) 以版本拼接串为快照；六张概览卡（Pubsub/Keyspace/Metrics/Slowlog/Memory/ServerOverview）只订阅实际读取字段，CLI/搜索进度写入不再连带重渲染 |
| 7c971c9 | 树形虚拟化：flattenVisibleTree 按折叠态前序展平；KeyTreeNode rowOnly 单行化；与平铺共用滚动容器/spacer/ResizeObserver，行高随密度；数据集切换滚动归零 |

## 二、验证结果（全部实际执行）

### 自动化检查
- ✅ typecheck（tsconfig.web + tsconfig.node 双工程）
- ✅ **261/261 测试全过**（23 文件）= 213 原有 + 27 真实 Redis 集成 + 10 渲染层单测 + 5 字段版本单测 + 6 树展平单测
- ✅ i18n 三语字典 1656 键一致
- ✅ 样式规范 15 项断言
- ✅ 生产构建成功（CSP hash 自动更新；JS 1488.60KB / gzip 445.57KB）

### 真实 Redis 集成（Docker redis:7-alpine @127.0.0.1:6390/db15，独立于用户 6379）
- string 3MB 分段续读拼回完整内容；UTF-8 三字节字符跨 2MB 边界不丢字（游标按实际消费字节推进）
- whole=true 整读 3MB 一次返回；valueBinary 5MB 值只取回前 4MB（STRLEN 给真实大小）
- gzip/zlib 异步解压结果正确；MULTI 原子整写（hash/list/set/zset/stream）；KEEPTTL 保留剩余 TTL；1200 元素分片不丢
- 微操作全分支：新增/重复/越界/改名/防覆盖拒绝（renameKey 目标存在时 reject 且原值不动）
- bulk：逐键结果（不存在记失败）、映射自身跳过记成功、目标冲突记失败、**取消令牌实测第一批 500 键即停**（1500 键任务 succeeded=500，未处理键仍在库）
- **揪出并修复历史 bug**：insertListElement BEFORE 场景哨兵残留（集成测试实测踩中，非本轮引入）

### 浏览器 mock 冒烟（Playwright 实测，phase2 最终状态）
- 连接「本地开发」→ 键树渲染 19 行（86 键加载）
- 展开 bulkdemo（60 子键）→ 子行入列、缩进 22px 正确
- **全部展开 15 目录 → 39 可见行只渲染 31 行**（视口+overscan），spacer 72px/120px 正确撑起 944px 滚动高度
- 滚动到 400px → 切片更新（首行 geo1），spacer 192px/0px，渲染行数恒定 31
- 右键菜单（拆出的 KeyContextMenu）：查看值/复制键名/复制键值/复制为命令/收藏/重命名 全部呈现
- 点击键 → 值区正确显示 session:3b8d0f51（string 编辑器）
- 勾选模式：27 复选框；目录全选 checked、部分选中 **indeterminate=true** 正确
- 平铺视图切换正常（29 行渲染 / 2674px 滚动高度）
- 概览「详情」→ 监控卡片 → 开启采样成功；**CLI 执行 DBSIZE→1284 期间监控采样不中断**（字段级订阅生效，cliEntries 写入不连带概览卡）

## 三、未实施项（明示排除，建议后续独立分支）

- CSS 428KB 双形态选择器裁剪：需全量消费场景验证，风险高
- KeyBrowser/ValueViewer 进一步按类型拆分：当前拆分已覆盖弹窗/菜单/树行等独立边界，剩余主体与共享状态耦合深，收益/风险比低

## 四、证据与限制

- 审查清单：research/keyper-perf-review_final.md（22 项，P0 全部 + P1/P2 大部分已实施）
- 性能收益为 RTT/复杂度推断 + 浏览器行为实测，未做真实 SSH 隧道下的端到端计时
- 测试容器 keyper-perf-test 验证后停止（--rm 自动删除）
- 分支未推送远端，合并时机由用户决定