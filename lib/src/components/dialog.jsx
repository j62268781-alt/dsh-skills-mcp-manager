/**
 * The delete confirmation, rendered with DSH's own UI primitives so it matches
 * the built-in dialogs (title / description / footer props, official Button).
 *
 * The primitives module is injected, which keeps this file free of any import of
 * the host app and unit-testable without a DOM.
 */
export function deleteConfirmDialog({ dialog, primitives, onCancel, onConfirm }) {
  if (dialog === null || dialog === undefined) return null
  const Modal = primitives?.Modal
  if (Modal === undefined) return null
  const Button = primitives.Button ?? 'button'
  return (
    <Modal
      open
      onClose={onCancel}
      title={`删除「${dialog.label}」？`}
      closeLabel="关闭"
      description={dialog.note}
      footer={
        <>
          <Button variant="outline" key="cancel" onClick={onCancel}>取消</Button>
          <Button variant="primary" key="ok" onClick={onConfirm}>删除</Button>
        </>
      }
    />
  )
}
