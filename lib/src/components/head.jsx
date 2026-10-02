/**
 * The panel's page head: title and one-line intro.
 *
 * JSX compiles to `__dshReact.createElement(...)` — a global the entry sets from
 * the host's `require('react')` (see esbuild.config.mjs for why it is a global).
 */
export const PAGE_TITLE = 'Skills & MCP'
export const PAGE_INTRO = '全局与项目级分层管理；保存后立即生效。'

/** Build the head element. */
export function pageHead() {
  return (
    <div className="smp-pageHead" key="head">
      <div key="text">
        <h2 className="smp-pageTitle" key="h">{PAGE_TITLE}</h2>
        <p className="smp-pageIntro" key="p">{PAGE_INTRO}</p>
      </div>
    </div>
  )
}
