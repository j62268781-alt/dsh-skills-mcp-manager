/**
 * Group heading: a collapsible title row plus the scope subtitle.
 *
 * Returns two sibling nodes (row + subtitle) because the callers spread them
 * into their own list. The chevron component is injected so this file stays
 * framework-agnostic.
 */

/** Build `[titleRow, subtitle]`. */
export function groupHead({ h, Chevron, open, onToggle, title, subText, action }) {
  return [
    h('div', { className: 'smp-groupTitleRow', key: 'row' }, [
      h('button', { className: 'smp-groupToggle', key: 'toggle', onClick: onToggle }, [
        h(Chevron, { key: 'c', open }),
        h('span', { className: 'smp-groupTitle', key: 't' }, title),
      ]),
      h('span', { style: { flex: 1 }, key: 'sp' }),
      action,
    ]),
    h('div', { className: 'smp-groupSub', key: 'sub' }, subText),
  ]
}
