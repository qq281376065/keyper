/**
 * 连接参数校验（纯函数，主进程入口兜底用）。
 *
 * 渲染层表单已有同名约束（ConnectionDialog 的 canSubmit / sshError），
 * 这里在主进程 connect/test 入口再拦一道：IPC 参数不可信，
 * 非法端口不该变成 ioredis/ssh2 的底层 RangeError 或误导性网络错误。
 */

/** 端口合法性：整数且 1-65535 */
export function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
}