/**
 * The React instance every JSX source in this bundle uses.
 *
 * DSH evaluates a client bundle as a classic script and hands the plugin React
 * through the factory's `require`, so a file must NOT `import 'react'` — that
 * would add a top-level ESM import to the bundle and break loading (the shipped
 * bundles have none). Instead the entry injects React here once, and every JSX
 * file imports this binding, which is live by the time anything renders.
 */
export let React = null

/** Called once by the panel entry with the host's React. */
export function setReact(next) {
  React = next
}
