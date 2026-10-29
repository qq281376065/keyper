/**
 * 语义化版本比较（主进程与渲染层共用）。
 *
 * 放在 shared 而不是 electron/services：这段逻辑既要被主进程的更新检查用，
 * 也要能被单元测试直接引入（测试工程的 include 不覆盖 electron 目录）。
 */

/** 返回 a>b ? 1 : a<b ? -1 : 0 */
export function compareVersion(a: string, b: string): number {
  const norm = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, '')
      // 预发布标记（-beta.1）不参与主序比较，只比数字段
      .split('-')[0]!
      .split('.')
      .map((part) => {
        const n = Number.parseInt(part, 10)
        return Number.isFinite(n) ? n : 0
      })

  const pa = norm(a)
  const pb = norm(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}
