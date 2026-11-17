# Keyper 性能审查 · 交叉核验

Route: C（file-only）
Evidence Budget: 外部检索 0 次（任务限定项目源码）；本地读取约 40 个文件段（read_file/grep/sed）；4 个维度；证据台账 30 行，全部绑定 file: 路径+行号，excerpt 由程序从工作树逐字抽取。
计划维度数（研究前确定）：4（数据链路 / 事件循环阻塞 / 渲染层 / 构建启动）。实际覆盖：4。
子代理：未使用（未授权委派，按 skill 本地顺序执行，预算相应缩减）。

## 问题地图（question map）

| question | support needed | candidate/source | finding and limit | status |
| --- | --- | --- | --- | --- |
| 哪些路径还有多余 RTT？ | 命令调用序列源码 | connection-manager.ts 全文 | D1-1/2/3/4/5；握手与搜索已优化 | 已答（dim01） |
| 主进程哪里会阻塞事件循环？ | 同步 API 调用点 | valueBinary/log-service/settings-store/mc client | D2-1..4 | 已答（dim02） |
| 重渲染为何被放大？ | store 订阅机制+组件订阅点 | reactiveStore/subscription/useRedis/Workspace | D3-1..5；Compiler 已启用但穿透点明确 | 已答（dim03） |
| 大列表/大值渲染是否有虚拟化与上限？ | 列表渲染分支+分页常量 | KeyBrowser/VirtualRows/limits.ts | 平铺/值区已虚拟化，树未虚拟化；string 无上限 | 已答（dim01/03） |
| 包体与启动还有哪些可裁？ | 构建配置+产物实测 | vite.config/dist wc -c/builder yml | D4-1/2；启动已优化 | 已答（dim04） |
| 定时器/连接是否有泄漏？ | 创建与清理配对 | probeTimer/keepalive/useTtlClock/各卡片 effect | 清理配对完整；心跳 race 定时器为小瑕疵 | 已答（dim01/03/04） |
| 实际耗时收益多少？ | 运行时 profile | 无（静态审查） | 未实测，全部为 RTT/复杂度推断 | 未答（明示缺口） |

## High Confidence（源码直接证据，行号可复核）

- string GET 整值无上限；valueBinary 先整取后截断（dim02 D2-1）。
- gunzipSync/inflateSync 同步解压，上限 20MB（D2-2）。
- 单键微操作 3–5 串行 await；批量任务渲染层逐键 IPC（D1-1/2）。
- appendLog/appendErrorLog/settings 同步文件 IO；错误日志每次写入触发全目录 prune（D2-3）。
- Memcached Buffer.concat 每 chunk 全量拷贝 + indexOf 从 0 重扫（D2-4）。
- store 全局版本广播 + 20+ 组件整店订阅；prettyJson 未 memo；buildApi 每渲染重建（D3-1/2/3）。
- loadAll 逐键 push；settings save 双轮 assign（D3-4/5）。
- 树形无虚拟化、sortTree 未复用 Collator（D3-6）。
- 单 JS 1.53MB / CSS 346KB（实测字节数）；mock 静态打包（D4-1）。
- 已优化项清单（避免误报）：握手 pipeline、searchAll 下沉、VirtualRows、useTtlClock、utf8Bytes、语言包裁剪、防白屏、Activity。

## Medium Confidence（机制成立，量级未实测）

- 「SSH 下每 RTT 50–150ms」引自项目自身注释（connection-manager L1147/L1362），非本轮实测。
- 各优化的耗时收益（省 2–4 RTT、O(n²)→O(n)、重渲染次数下降）为复杂度推断。
- React Compiler 对未 memo 计算的实际拦截程度未 profile。

## Low Confidence / 未纳入清单

- 隐藏标签内存增长的绝对量级（取决于用户数据，未测）——仅列为可选增强。
- CSS 双形态选择器是否可安全裁剪一半：未验证所有消费场景，只建议「确认后裁」。

## Conflict Zones

- 无来源间冲突（单一来源=项目源码）。
- 唯一张力是产品语义 vs 性能：批量原子性、逐键失败明细、切换零重建 —— 已在各维度「张力/反论」节记录，清单建议均保留原语义。

## Validation Updates

- 台账 30 行 excerpt 全部由 execute_code 从工作树按行号逐字抽取（非手抄），SlowlogCard 行使用两段分离原文（L506-511 与 L513-523），未拼接改写。
- 首轮校验（--route C --min-dimensions 4）：30 行全部被 REJECTED_EVIDENCE 拒绝，原因是校验器要求摘录文本内出现实体名「Keyper」且与 claim 词面重合 ≥5 token，而这些源码行本身不含产品名。
- 处置：不伪造摘录、不改写源码引文。30 行按契约改标 `unverified`（confidence=medium，unverified_reason 注明「源码行人工核对属实，词面绑定检查因代码行不含产品名而无法通过」），排除出 verified_facts。
- 因此本审查的交付模式为 framework/partial：全部发现仍以「file: 路径#行号 + 逐字源码摘录」形式在台账与维度文件中完整保留，可由任何人按行号复核；最终清单的依据是人工核对的源码，而非校验器的 verified 子集。
- 复验报告见 qa/keyper-perf-review_research_check.json（以最后一次运行为准）。