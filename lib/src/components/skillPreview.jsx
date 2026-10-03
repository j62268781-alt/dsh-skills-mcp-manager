/** Skill preview dialog, rendered with DSH's own Modal so it matches the built-in
 * pages. The body is plain text on purpose: the panel depends on no markdown
 * renderer, so it never pretends to render markdown.
 *
 * No footer button: the modal already carries a close control in its header.
 */
export function skillPreviewDialog({ skill, body = '', pending = false, primitives, onClose }) {
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
        {/* A <div> with pre-wrap, not <pre>: <pre> refuses to shrink below its
            longest unbreakable run, which pushed lines past the right padding. */}
        <div className="smp-preview" key="body">
          {pending ? '读取中…' : (body !== '' ? body : (skill.body ?? ''))}
        </div>
      </div>
    </Modal>
  )
}
