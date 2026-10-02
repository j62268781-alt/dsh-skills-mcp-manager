/**
 * The disclosure chevron used by cards and group headings.
 *
 * JSX version of the inline component; the name is unchanged so call sites and
 * the `Chevron` prop passed into groupHead keep working as-is.
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
