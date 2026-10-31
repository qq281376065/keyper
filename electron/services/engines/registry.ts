import type { CacheConnectionConfig, CacheEngine } from '../../../shared/types'
import { t } from '@shared/i18n'

/**
 * 引擎路由表。
 *
 * 这个文件的唯一职责是"按引擎把请求分给谁"，它**不 import 任何引擎实现** ——
 * 具体实现由调用方（ipc 层）注册进来。这样做的原因：
 *   1. 避免 engines/index 变成新的上帝模块，把两个引擎又粘在一起；
 *   2. 主进程启动时按需注册，未启用的引擎不产生任何副作用；
 *   3. 单测可以注册假实现，不必拉起真实连接。
 *
 * 新增引擎的完整动作：
 *   ① shared/types.ts 加一个子类型 + CacheEngine 成员
 *   ② 在 engines/<名字>/ 下写实现（不得 import 其它引擎目录）
 *   ③ 主进程启动处 registerEngine(...)
 *   ④ 前端 ENGINES 表加一行
 * 任何一步漏掉都会被类型系统或"未注册引擎"错误挡住。
 */

export interface EngineHandlers<TConnect, TTest> {
  /** 建立连接，返回该引擎特有的状态对象 */
  connect: (config: CacheConnectionConfig) => Promise<TConnect>
  /** 测试连通性（不建立持久连接） */
  test: (config: CacheConnectionConfig) => Promise<TTest>
  /** 断开 */
  disconnect: (id: string) => unknown
}

const registry = new Map<CacheEngine, EngineHandlers<unknown, unknown>>()

/** 注册一个引擎。重复注册会被覆盖并告警 —— 通常是初始化写了两遍。 */
export function registerEngine(engine: CacheEngine, handlers: EngineHandlers<unknown, unknown>): void {
  if (registry.has(engine)) {
    console.warn(`[engine-registry] ${engine} 被重复注册，后注册的实现生效`)
  }
  registry.set(engine, handlers)
}

/** 取引擎实现；未注册时抛出明确错误而不是静默走到别的引擎 */
export function getEngine<TConnect, TTest>(
  engine: CacheEngine,
): EngineHandlers<TConnect, TTest> {
  /*
   * 先判空再查表。
   *
   * 不判空的话，engine 为 undefined / null 时会一路走到下面那条
   * "引擎 {engine} 尚未注册" —— 插值拿到 undefined 后原样保留占位符，
   * 用户看到的是字面量 `{engine}`，既不说明缺了什么、也看不出是缺字段
   * 还是引擎没注册。这两种原因的处置方式完全不同（补配置 vs 装引擎），
   * 所以必须分开报。
   */
  if (engine === undefined || engine === null || (engine as string) === '') {
    throw new Error(t('engine.engineFieldMissing'))
  }

  const handlers = registry.get(engine)
  if (!handlers) {
    throw new Error(t('engine.engineNotRegisteredCannotHandle', { engine }))
  }
  return handlers as EngineHandlers<TConnect, TTest>
}

/** 已注册的引擎列表（调试与自检用） */
export function registeredEngines(): CacheEngine[] {
  return [...registry.keys()]
}
