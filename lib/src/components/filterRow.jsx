/**
 * The filter row: the search box plus the tab's primary action.
 *
 * One row, one meaning: search on the left, the action on the same line — so the trigger and
 * the list it appends to stay on one screen.
 *
 * There used to be a project selector here. **Neither tab has one now**: a server's scope is
 * chosen in its own form, and the skills list shows every workspace at once (a skill's
 * workspace is chosen in the add dialog). Keeping the selector would have meant a control that
 * filters nothing.
 */

/** Build the filter row. */
export function filterRow({ query, onQuery, placeholder, actions = null }) {
  return (
    <div className="smp-filterRow" key="filter">
      <div className="smp-search" key="search">
        <span className="smp-searchIcon" key="i">
          <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M7 12a5 5 0 100-10 5 5 0 000 10zm3.5-1.5L14 14"
              stroke="currentColor" strokeWidth={1.3} strokeLinecap="round"
            />
          </svg>
        </span>
        <input
          className="smp-searchInput"
          key="in"
          placeholder={placeholder}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>

      {actions}
    </div>
  )
}
