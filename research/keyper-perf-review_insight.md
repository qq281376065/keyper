# Keyper 性能审查 · 跨维度洞察

## Insight: 剩余性能问题集中在「高频小操作」，而非「低频大操作」

Derived From: Dim 01, Dim 02, Dim 03
Evidence Cluster: connection-manager L1877-1880/L2186-2194、session.ts L1170-1214、ipc/index.ts L385-398、reactiveStore L40-43
Rationale: 项目已把低频重路径（握手、全库搜索、监控采样、值分页）优化到位；但每次点击都发生的微操作（加一个成员、删一行、批量 1000 键）仍叠加「串行 RTT × IPC × 同步日志 × store 广播」四层开销。四层各自不大，乘起来在 SSH 场景是数百 ms 到分钟级。
Implications: 优先级应给 D1-1/D1-2/D2-3 这类「每次交互都付税」的点，而不是继续雕琢已经 pipeline 化的大路径。
Confidence: high（机制）/ medium（量级）

## Insight: 渲染层的根因是订阅粒度，点状 memo 只是止血

Derived From: Dim 03
Evidence Cluster: reactiveStore L40-43/L107、subscription.ts L20-22、string.ts L42、Workspace L36-37
Rationale: 全局版本号广播让任何字段写入都触发全组件渲染流程；prettyJson 未 memo、buildApi 重建、逐键 push 都是在这个放大器上的具体负载。只修点状问题（memo prettyJson）能消掉最痛的一根刺，但消息高频场景（Pub/Sub、搜索进度）仍会持续放大。
Implications: 短期修 D3-2（一行 memo）+ D3-4（整批赋值）；中期做 useSelector 或高频字段拆 store，才能根治。
Confidence: high

## Insight: 主进程单线程是共享瓶颈，同步 API 的代价由所有连接分摊

Derived From: Dim 02
Evidence Cluster: valueBinary L1341-1344、log-service L134-135/L286-287、mc client L178-179
Rationale: 一次 20MB 同步解压或大 metadump 的 O(n²) 拼接，阻塞的不只是发起操作的那条连接——所有连接的 IPC、心跳、状态推送同停。多标签多连接的产品形态放大了这一点。
Implications: D2-2（异步 zlib）是改动最小、全局收益最确定的一项；D2-1（STRLEN+GETRANGE）是唯一能防「单个大键拖死全应用」的护栏。
Confidence: high（机制）/ medium（量级）

## Insight: 体积问题一半是迁移遗留

Derived From: Dim 04, Dim 03
Evidence Cluster: components.css 双形态选择器、api/index.ts 静态 import mock、useRedis 注释「Vue 移植」
Rationale: 428KB CSS 的双形态选择器与 2625 行 mock 进生产包，都是 Vue→React 迁移期的兼容产物；功能已稳定，兼容层可以开始回收。
Implications: mock 动态导入是低风险即改项；CSS 裁剪需先验证消费场景，列为低优先。
Confidence: medium