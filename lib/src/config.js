/**
 * Reading the panel's settings document through the config form controller.
 *
 * `form` is whatever the settings slots hand us (it exposes getSnapshot(), a
 * store with getSnapshot(), or a plain snapshot), so these helpers normalise the
 * three shapes in one place.
 */

/** The settings document value, or `{}` when the form is not ready. */
export function snapshotOf(form) {
  const snapshot = form?.getSnapshot?.() ?? form?.store?.getSnapshot?.() ?? form?.snapshot
  return snapshot?.value ?? snapshot ?? {}
}

/** The form's status string (`ready` unless the controller says otherwise). */
export function statusOf(form) {
  const snapshot = form?.getSnapshot?.() ?? form?.store?.getSnapshot?.() ?? form?.snapshot
  return snapshot?.status ?? 'ready'
}

/** One array field of the document; non-arrays read as an empty list. */
export function listOf(form, field) {
  const value = snapshotOf(form)?.[field]
  return Array.isArray(value) ? value : []
}
