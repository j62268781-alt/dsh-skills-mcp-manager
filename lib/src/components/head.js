/**
 * The panel's page head: title and one-line intro.
 *
 * Kept separate so the copy can be pinned by tests and reused by the offline
 * preview harness.
 */

export const PAGE_TITLE = 'Skills & MCP'
export const PAGE_INTRO = '全局与项目级分层管理；保存后立即生效。'

/** Build the head element. `h` is React's createElement, injected by the caller. */
export function pageHead(h) {
  return h('div', { className: 'smp-pageHead', key: 'head' }, [
    h('div', { key: 'text' }, [
      h('h2', { className: 'smp-pageTitle', key: 'h' }, PAGE_TITLE),
      h('p', { className: 'smp-pageIntro', key: 'p' }, PAGE_INTRO),
    ]),
  ])
}
