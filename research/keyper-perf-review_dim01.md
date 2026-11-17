# Keyper 性能审查 · 维度 01：主进程 Redis 数据链路

Route: C · 证据均为源码行号（工作树，基线 38ef06d v1.1.4）。耗时收益为按 RTT 推断，非实测。

## 现状

数据链路整体质量高：握手 PING+INFO 合并 pipeline（connection-manager.ts L607-611）、searchAll 循环下沉主进程（L1255-1301）、TYPE/TTL 批量 describeKeys（L1169-1186）、databases CONFIG+INFO 合并（L1151-1155）、metrics INFO+DBSIZE 合并（L737-741）。注释显示项目已做过多轮 RTT 优化（SSH 隧道单程 50–150ms 口径，L1147）。剩余问题集中在**单键微操作**与**批量任务**。

## 发现

### D1-1 单键微操作 3–5 次串行往返（高优先）
- addZsetMember：EXISTS→ZSCORE→ZADD→ZCARD 4 await（L1877-1880）；addSetMember：EXISTS→SADD→SCARD（L2159-2161）；appendListElement：EXISTS→RPUSH→LLEN（L2229-2231）。
- deleteListElement：LLEN→LINDEX→LSET→LREM→LLEN 5 await（L2181-2194）；insertListElement：LINDEX→LSET→LINSERT→LSET 4 await（L2253-2263）。
- renameKey：EXISTS→RENAME（L2322-2326）；setHashField：EXISTS→HSET→(HEXPIRE)→(HDEL)（L2294-2308）。
- 这些命令互不依赖或可容忍弱一致，可 pipeline 合并为 1 RTT。SSH 场景每次交互省 2–4×50–150ms。
- 注意：EXISTS 前置检查与写入合并后语义从「先检查后写」变为「同批执行」，对改名冲突检查（renameKey 防覆盖）需保留判断顺序或用 Lua/RENAMENX 保语义。

### D1-2 批量任务在渲染层逐键循环（高优先）
- session.ts runBulkTask L1170-1214：每键一次 `api.redis.remove/setTtl/rename` IPC → 主进程一次命令往返 → handle 包装写一条操作日志（ipc/index.ts L385-398）。1000 键 ≈ 1000×(IPC+RTT+同步写盘)。
- 主进程已有批量 deleteKeys（L1689-1693），但批量面板没走它；TTL/重命名无批量通道。
- 建议：主进程新增 bulk 接口（DEL 分片 500/批、EXPIRE pipeline、RENAME 逐条但循环留在主进程），进度推送节流合帧；保留逐键失败明细语义。

### D1-3 setValue 非原子整写 + stream 逐条 XADD（中）
- hash/list/set/zset：DEL 后整写两条独立命令（L1626-1657），中间态可被其他客户端读到、失败留空键；可用 pipeline/MULTI 包裹。
- stream 分支 for 循环逐行 await xadd（L1671-1677），N 行 N RTT；可 pipeline。
- 大集合写入还受 argv 数量限制（rpush/sadd 展开 payload），建议分片。

### D1-4 deleteKeys/describeKeys 无分片（中）
- `client.del(...keys)`（L1692）与 describeKeys 全量 pipeline（L1171-1176）：批量面板全选数千键时单命令 argv 巨大、回复缓冲集中；建议 500/批分片。

### D1-5 memoryAnalysis 串行 100 批 + 无进度/取消（中）
- L905-934：SCAN COUNT 2000 → 每 100 键 MEMORY USAGE pipeline await。上限 10k 键 ≈ 100 串行 RTT，SSH 下 5–15s 无进度反馈、不能取消（searchAll 已有令牌机制可复用）。
- 建议：批间并发 2–4 路 pipeline、复用 searchTokens 取消、进度推送。

### D1-6 metrics 每字段全文正则（低）
- L744-745：read(field) 每次 `new RegExp` 扫全文 INFO；2s 一次 × ~17 字段。一次 split 建 Map 即可 O(1) 取值，主进程 CPU 微优化。

### D1-7 心跳 Promise.race 定时器不清理（低，卫生类）
- L429-432：每 15s 心跳创建 3s setTimeout，ping 先回时定时器仍存活至到点；ping 永不结算时（半开死链恰恰如此）promise 悬挂。量级小（每连接每 15s 一个），但建议 clearTimeout + finally。

## 受影响系统
所有 Redis 连接的交互延迟（尤其 SSH 隧道用户）、批量操作吞吐、主进程日志量。

## 张力/反论
- 逐键循环换来的是「逐键失败明细 + 随时取消」的产品语义，批量化必须保留这两点（分片间检查取消令牌即可）。
- pipeline 合并改变错误时序：ioredis pipeline 单项失败不中断，需逐项检查 [err,res]（项目已有此惯例）。

## 置信度
行号证据 high；收益量级 medium（RTT 推断）。