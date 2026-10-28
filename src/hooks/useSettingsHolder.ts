/**
 * 设置的单例订阅句柄。
 *
 * 设置是模块级单例（services/settings 的 settingsHolder），
 * 但它的写入可能发生在任意子组件 —— 例如侧栏折叠、分隔条拖拽。
 * 这些组件需要订阅它才能重渲染，因此单独导出一个 hook。
 */
import { settingsHolder } from '@/services/settings'
export function useSettingsHolder() {
  return settingsHolder
}
