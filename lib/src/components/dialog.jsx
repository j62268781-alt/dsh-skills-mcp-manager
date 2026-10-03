/**
 * The delete confirmation, rendered with DSH's own UI primitives so it matches
 * the built-in dialogs (title / description / footer props, official Button).
 *
 * The primitives module is injected, which keeps this file free of any import of
 * the host app and unit-testable without a DOM.
 *
 * While `pending` the dialog stays open and says so: the card is only gone once
 * the Host has actually removed the directory (and left its backup).
 */
export function deleteConfirmDialog({ dialog, primitives, onCancel, onConfirm, pending = false, error = '' }) {
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
      description={
        <div className="smp-deleteMeta" key="meta">
          <div key="note">{dialog.note}</div>
          {error !== '' ? <div className="smp-error" key="err" style={{ marginTop: 6 }}>{error}</div> : null}
          {pending ? <div className="smp-pendingHint" key="pending">正在删除并刷新列表…</div> : null}
        </div>
      }
      footer={
        <>
          <Button variant="outline" key="cancel" onClick={onCancel} disabled={pending}>取消</Button>
          <Button variant="primary" key="ok" onClick={onConfirm} disabled={pending}>
            {pending ? '删除中…' : '删除'}
          </Button>
        </>
      }
    />
  )
}
