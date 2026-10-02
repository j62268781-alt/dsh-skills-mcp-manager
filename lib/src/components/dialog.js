/**
 * The delete confirmation, rendered with DSH's own UI primitives so it matches
 * the built-in dialogs (title / description / footer props, official Button).
 *
 * React's createElement (`h`) and the primitives module are passed in, which
 * keeps this file framework-agnostic and unit-testable without a DOM.
 */

/** Build the confirmation dialog for a pending delete, or null when idle. */
export function deleteConfirmDialog({ dialog, primitives, h, onCancel, onConfirm }) {
  if (dialog === null || dialog === undefined) return null
  const Modal = primitives?.Modal
  if (Modal === undefined) return null
  const Button = primitives.Button ?? 'button'
  return h(Modal, {
    open: true,
    onClose: onCancel,
    title: `删除「${dialog.label}」？`,
    closeLabel: '关闭',
    description: dialog.note,
    footer: h(Fragment(h), null, [
      h(Button, { key: 'cancel', variant: 'outline', onClick: onCancel }, '取消'),
      h(Button, { key: 'ok', variant: 'primary', onClick: onConfirm }, '删除'),
    ]),
  })
}

/** React.Fragment, taken from the injected createElement's module when possible. */
function Fragment(h) {
  return h.Fragment ?? 'div'
}
