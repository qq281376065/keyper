/**
 * 按前缀替换规则计算键的新名字。
 *
 * from 留空时给整个键名前面加 to（"仅添加前缀"是最常见的批量改名诉求）；
 * from 命中前缀则替换该前缀；未命中或替换后没有变化都返回原键名，
 * 执行侧会把"没有变化"的行直接记成功跳过，不浪费一次 RENAME 往返。
 *
 * 独立成纯函数文件的原因：原先定义在 redisSession.ts（其 import 链会拉起
 * @/api 的 window 依赖，node 测试环境无法加载），单元测试需要零副作用模块。
 * redisSession.ts 对此函数 re-export，既有 import 路径全部保持不变。
 */
export function renamedKey(key: string, from: string, to: string): string {
  if (from) return key.startsWith(from) ? to + key.slice(from.length) : key
  return to ? to + key : key
}