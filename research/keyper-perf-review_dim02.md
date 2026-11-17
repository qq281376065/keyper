# Keyper 性能审查 · 维度 02：主进程事件循环阻塞点

Route: C · 主进程是单线程，任何同步长任务都会让**全部连接的 IPC 停摆**。

## 发现

### D2-1 string 整值 GET 无上限（高）
- getValue string 分支 `client.get(key)`（connection-manager.ts L1391-1394），注释自认「string 无法分页」。Redis string 上限 512MB；几百 MB 的值会同时撑爆主进程内存、IPC 结构化克隆与渲染层。
- valueBinary 同样先 getBuffer 整值再截 4MB（L1322-1327）——截断发生在**取回之后**，传输与内存峰值未被限制。
- 建议：先 STRLEN 探测，超阈值（如 2MB）改 GETRANGE 分段读取 + 「值过大，仅加载前 N 字节」提示；valueBinary 用 GETRANGE 0..MAX 直接限量取回。

### D2-2 gunzipSync/inflateSync 同步解压最大 20MB（高）
- L1341-1344：解压上限 VALUE_DECODE_MAX_BYTES_CAP=20MB（shared/limits.ts），同步执行期间主进程完全阻塞（大压缩比数据可达秒级）。
- 建议：zlib.gunzip/inflate 异步回调版（libuv 线程池），一行改动级别；maxOutputLength 保留。

### D2-3 同步文件 IO 在热路径（中）
- appendLog：每条操作日志 mkdirSync+appendFileSync（log-service.ts L126-139）；批量任务逐键时等于逐键写盘。
- appendErrorLog：每次写入后 pruneOldErrorLogs 两次 readdirSync 全目录（L286-287, L294-318）；错误风暴时 O(N²)。
- settings-store：loadSettings 每次全量读盘 JSON.parse（L58-78），saveSettings 读+写全量（L86-99）；expandedPaths 随连接数增长，键栏拖拽 onCommit、树展开防抖 400ms 都会触发。
- 建议：日志改 fs.createWriteStream 追加（或 fs.promises.appendFile 队列）；prune 每天一次（操作日志已有 lastPruneDay 先例 L123-133）；settings 进程内缓存 + 防抖落盘。

### D2-4 Memcached 收包 O(n²) 缓冲拼接与重复扫描（中）
- client.ts onData L178-179：每 chunk `Buffer.concat([buffer, chunk])` 全量拷贝；untilEnd/untilEndLoose（L260-292）每次从 0 indexOf。metadump all 大实例（数十万键、几十 MB 响应）时是二次方拷贝+扫描。
- 建议：chunk 数组 + 长度计数，收齐判定只扫「新增尾部 ± marker 长度」的重叠窗口；或缓存上次扫描偏移。

### D2-5 搜索进度每批广播（低）
- searchAll 每批 emitSearchProgress（L1295-1297）→ ipc 广播 → 渲染层写 remoteSearch（global.ts L164-171）→ 会话 store emit → 订阅组件重渲染。百万键库 ≈ 200 批，每批一次全链。建议主进程 100–200ms 节流。

## 受影响系统
主进程响应性（所有连接共享一个事件循环）；大 value/大 Memcached 实例场景最明显。

## 张力/反论
- 同步 IO 换来了「日志绝不丢」的简单语义；改异步队列需处理退出 flush（before-quit）。
- GETRANGE 分段对二进制安全（按字节），但 UTF-8 多字节字符可能被切断，展示层需容错（valueBinary 已有 base64 通道可复用）。

## 置信度
行号证据 high；「秒级阻塞」为复杂度推断 medium，未实测。