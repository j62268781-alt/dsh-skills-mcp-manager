/**
 * The MCP / Skills tab strip.
 *
 * Labels carry the entry counts (`MCP（5）`); switching tabs also clears the inline
 * editor and the expanded row — that reset lives in the caller's onSelect.
 */
import { tabLabel } from './filters.js'

/** Tab ids in render order, with their display titles. */
export const TAB_ITEMS = [
  { id: 'mcp', title: 'MCP' },
  { id: 'skills', title: 'Skills' },
]

/** Build the tab strip. `counts` is `{ mcp, skills }`. */
export function tabStrip({ active, counts = {}, onSelect }) {
  return (
    <div className="smp-tabs" key="tabs">
      {TAB_ITEMS.map((item) => (
        <button
          key={item.id}
          className="smp-tab"
          data-active={active === item.id}
          onClick={() => onSelect(item.id)}
        >
          {tabLabel(item.title, counts[item.id] ?? 0)}
        </button>
      ))}
    </div>
  )
}
