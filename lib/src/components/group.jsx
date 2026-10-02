/**
 * Group heading: a collapsible title row plus the scope subtitle.
 *
 * Returns two sibling nodes (row + subtitle) as an array, because callers spread
 * them into their own list. The Chevron component is injected by the caller.
 */
export function groupHead({ Chevron, open, onToggle, title, subText, action }) {
  return [
    <div className="smp-groupTitleRow" key="row">
      <button className="smp-groupToggle" key="toggle" onClick={onToggle}>
        <Chevron key="c" open={open} />
        <span className="smp-groupTitle" key="t">{title}</span>
      </button>
      <span style={{ flex: 1 }} key="sp" />
      {action}
    </div>,
    <div className="smp-groupSub" key="sub">{subText}</div>,
  ]
}
