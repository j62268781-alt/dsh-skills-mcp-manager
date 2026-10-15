/**
 * The disclosure chevron used by the cards on both tabs.
 *
 * JSX version of the inline component; the name is unchanged so call sites keep working.
 * (Group headings used to pass it through `groupHead`; both tabs are one plain list now, so
 * the only call sites are the cards.)
 */
export function Chevron({ open }) {
  return (
    <svg
      className="smp-chevron"
      data-open={String(open)}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
