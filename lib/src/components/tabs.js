/**
 * The MCP / Skills tab strip.
 *
 * Labels carry the entry counts (`MCP (5)`), and switching tabs also clears the
 * inline editor and the expanded row — that reset lives in the caller's onSelect.
 */
import { tabLabel } from './filters.js'

/** Tab ids in render order, with their display titles. */
export const TAB_ITEMS = [
  { id: 'mcp', title: 'MCP' },
  { id: 'skills', title: 'Skills' },
]

/** Build the tab strip. `counts` is `{ mcp, skills }`. */
export function tabStrip({ h, active, counts = {}, onSelect }) {
  // 展开为独立子元素（而不是传一个数组），与 React 的实际行为一致
  return h('div', { className: 'smp-tabs', key: 'tabs' }, ...TAB_ITEMS.map((item) =>
    h('button', {
      className: 'smp-tab',
      'data-active': active === item.id,
      key: item.id,
      onClick: () => onSelect(item.id),
    }, tabLabel(item.title, counts[item.id] ?? 0))))
}
