/**
 * One labelled form field.
 *
 * Kept as a plain function returning an element (rather than a component) because
 * the caller builds the control itself; call sites are unchanged by the JSX move.
 */
export function field(label, control, wide) {
  return (
    <label className="smp-field" key={label} data-wide={Boolean(wide)}>
      <span className="smp-label" key="l">{label}</span>
      {control}
    </label>
  )
}
