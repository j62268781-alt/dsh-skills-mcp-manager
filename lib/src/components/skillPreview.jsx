/** Skill preview dialog, rendered with DSH's own Modal so it matches the built-in
 * pages. The body is plain text on purpose: the panel depends on no markdown
 * renderer, so it never pretends to render markdown.
 *
 * No footer button: the modal already carries a close control in its header.
 */
export function skillPreviewDialog({ skill, primitives, onClose }) {
  if (skill === null || skill === undefined) return null
  const Modal = primitives?.Modal
  if (Modal === undefined) return null
  const tag = String(skill.source ?? '').endsWith('-agents') ? 'agents' : 'dsh'
  return (
    <Modal
      open
      onClose={onClose}
      title={`${skill.name ?? ''}（${tag}）`}
      closeLabel="关闭"
      description={
        <div className="smp-previewMeta" key="meta">
          {String(skill.description ?? '').trim() !== '' ? (
            <div className="smp-previewDesc" key="desc">{skill.description}</div>
          ) : null}
          {skill.path ? <div className="smp-previewPath" key="path">{`文件：${skill.path}`}</div> : null}
        </div>
      }
    >
      <div className="smp-previewWrap" key="wrap">
        <pre className="smp-preview" key="body">{skill.body ?? ''}</pre>
      </div>
    </Modal>
  )
}
