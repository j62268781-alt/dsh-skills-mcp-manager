/**
 * The tool inventory shown under an expanded MCP card.
 *
 * Data comes from the Host runtime endpoint's view of the harness tool registry,
 * keyed by serverName. Three states matter and
 * are deliberately distinct:
 *
 *   unknown  → the Host could not read the registry at all
 *   empty    → the registry was read, this server currently exposes nothing
 *   listed   → one row per tool, name + the server's own description
 *
 * The long `mcp__<server>__` prefix is shown in full: it is the exact name the
 * model must call, and long names are truncated with a hash suffix, so shortening
 * it here would print a name that does not work.
 *
 * Descriptions are shown whole (see `normalizeDescription`); only the CSS line clamp
 * bounds an unusually long one.
 */
import { toolsSummary } from './card.jsx'

/**
 * Normalize a description for display: collapse whitespace, keep the text whole.
 *
 * Measured over 35 real MCP tools on one machine: median 74 characters, p75 151,
 * p90 318, longest 2006. The distribution is short-bodied with a thin long tail, so
 * the panel shows the **whole** description and lets CSS clamp the rare monster to a
 * few lines — cutting at a fixed character count trimmed the majority for no reason,
 * and hid the point of the p90 cases entirely.
 */
export function normalizeDescription(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

export function toolListNode(inventory, keyPrefix = 'tools', filter = null) {
  // The separator/spacing lives on the heading (see panel.css), so the empty and
  // unreadable states — which render the heading alone — line up with the full list.
  const head = (trailing, tone) => (
    <div className="smp-toolHead" key={keyPrefix}>
      <span className="smp-toolTitle">工具</span>
      <span className="smp-toolCount" data-tone={tone}>{trailing}</span>
    </div>
  )
  if (inventory?.state !== 'listed') return head(`· ${toolsSummary(inventory)}`, 'muted')
  const { tools } = inventory
  if (tools.length === 0) return head(`· ${toolsSummary(inventory)}`, 'muted')

  // `filter` is absent on hosts that predate the feature, in which case this is the
  // plain read-only list it has always been.
  const selected = new Set(Array.isArray(filter?.tools) ? filter.tools : [])
  const mode = filter?.mode === 'allow' || filter?.mode === 'deny' ? filter.mode : 'off'
  const editMode = filter !== null && filter !== undefined
  // The mode selector is only worth showing when the Host can act on it. Without
  // that, this stays exactly the read-only list it was.
  const canEdit = editMode && filter.onMode !== undefined
  // Short names are a convenience of the picker; with filtering off the list keeps
  // the full public names, which is what it showed before this feature existed.
  const picking = canEdit && mode !== 'off'

  return (
    <div className="smp-tools" key={keyPrefix}>
      <div className="smp-toolHead" key="head">
        <span className="smp-toolTitle">工具</span>
        <span className="smp-toolCount">{`(${tools.length})`}</span>
        {canEdit ? (
          <span className="smp-toolModes" key="modes">
            {[['off', '全部保留'], ['allow', '只保留勾选'], ['deny', '只挡勾选']].map(([value, label]) => (
              <button
                type="button" key={value} className="smp-toolMode"
                data-active={String(mode === value)}
                onClick={() => filter.onMode(value)}
              >
                {label}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {picking ? (
        <p className="smp-note" key="hint">
          {mode === 'allow'
            ? `勾选要保留的工具（${selected.size}/${tools.length}）——没勾的不会注册给模型。`
            : `勾选要挡掉的工具（${selected.size}/${tools.length}）——其余照常注册。`}
        </p>
      ) : null}
      <ul className="smp-toolList">
        {tools.map((tool) => {
          const description = normalizeDescription(tool.description)
          // The picker shows the short name: the `mcp__<server>__` prefix is identical
          // on every row of this card and is re-added on save, so repeating it would
          // bury the one part that differs. Everywhere else the full public name
          // stays visible, because that is the name the model must call.
          const shown = picking && filter.leafOf !== undefined ? filter.leafOf(tool.name) : tool.name
          const checked = selected.has(shown)
          // The dimming means "this tool will not be registered", which is NOT the
          // checkbox state: `allow` keeps what is checked, `deny` keeps what is not.
          // Driving the style off the checkbox itself would dim the surviving tools
          // in `deny` mode — pointing the emphasis at exactly the wrong rows.
          const kept = mode === 'deny' ? !checked : checked
          return (
            <li className="smp-tool" key={tool.name} data-kept={picking ? String(kept) : undefined}>
              {picking ? (
                <label className="smp-toolPick" key="pick">
                  <input
                    type="checkbox" checked={checked}
                    onChange={(event) => filter.onToggle(shown, event.target.checked)}
                  />
                  <code className="smp-toolName" title={tool.name}>{shown}</code>
                </label>
              ) : (
                <code className="smp-toolName" title={tool.name}>{shown}</code>
              )}
              {description === '' ? null : (
                // `title` carries the full text: the CSS clamp trims only the visual
                // box, so hovering still reveals everything a long description says.
                <span className="smp-toolDesc" title={description}>{description}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
