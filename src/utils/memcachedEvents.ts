/**
 * Memcached 键集合变更通知。
 *
 * 左栏键浏览器、概览的键列表、右侧值查看器是三块独立状态：
 * 在值区或概览里删掉一个键后，左栏不会自动知道，列表会继续显示已删除的键。
 * Redis 三处共用 session store，天然同步；Memcached 没有这层共享数据，
 * 因此用一个进程内事件把"键集合变了"广播给关心它的面板。
 */

const KEYS_CHANGED_EVENT = 'mc:keys-changed'

export function emitMcKeysChanged(): void {
  window.dispatchEvent(new Event(KEYS_CHANGED_EVENT))
}

export function onMcKeysChanged(handler: () => void): () => void {
  window.addEventListener(KEYS_CHANGED_EVENT, handler)
  return () => window.removeEventListener(KEYS_CHANGED_EVENT, handler)
}
