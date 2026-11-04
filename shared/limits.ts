/**
 * 跨进程共享的容量与上限。
 *
 * 主进程负责真正钳制，渲染层只用它们做展示与输入提示；
 * 两边引用同一份常量，避免「界面允许输入 300、主进程却按 200 截断」这类错位。
 */
export const FAVORITES_LIMIT = 500
export const CLI_HISTORY_LIMIT = 200
export const LUA_SCRIPTS_LIMIT = 100
export const LUA_SCRIPT_MAX_BYTES = 256 * 1024
export const VALUE_BINARY_MAX_BYTES = 4 * 1024 * 1024
export const VALUE_DECODE_MAX_BYTES = 5 * 1024 * 1024
export const VALUE_DECODE_MAX_BYTES_CAP = 20 * 1024 * 1024
export const STREAM_PENDING_PAGE_SIZE = 50
export const STREAM_PENDING_PAGE_MAX = 200
