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
/**
 * string 值首屏字节上限：超过即只读前 N 字节（GETRANGE），
 * 界面显示「值过大，仅加载前 N 字节」并可继续加载更多。
 * 与 VALUE_BINARY_MAX_BYTES 同量级但独立：文本走 UTF-8 解码展示，
 * 二进制走 base64，两条路径的截断口径分开演进。
 */
export const VALUE_STRING_MAX_BYTES = 2 * 1024 * 1024
/** string「加载更多」每页字节数 */
export const VALUE_STRING_PAGE_BYTES = 2 * 1024 * 1024
/**
 * string 整值读取硬上限（复制全部 / 导出全部路径）：
 * 超过即截断并标记 truncated，防止单个大键把主进程与 IPC 撑爆。
 */
export const VALUE_STRING_WHOLE_MAX_BYTES = 32 * 1024 * 1024
export const STREAM_PENDING_PAGE_SIZE = 50
export const STREAM_PENDING_PAGE_MAX = 200
export const LUA_RESULT_MAX_CHARS = 1024 * 1024
