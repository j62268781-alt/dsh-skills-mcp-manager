/**
 * Skill preview dialog, rendered with DSH's own Modal so it matches the built-in
 * pages. The body is shown as plain text on purpose: the panel depends on no
 * markdown renderer, so it never pretends to render markdown.
 */
export function skillPreviewDialog({ skill, primitives, onClose }) {
  if (skill === null || skill === undefined) return null
  const Modal = primitives?.Modal
  if (Modal === undefined) return null
  const Button = primitives.Button ?? 'button'
  const tag = String(skill.source ?? '').endsWith('-agents') ? 'agents' : 'dsh'
  return (
    <Modal
      open
      onClose={onClose}
      title={`${skill.name ?? ''}（${tag}）`}
      closeLabel="关闭"
      description={[skill.description, skill.path ? `文件：${skill.path}` : ''].filter(Boolean).join(' · ')}
      footer={<Button variant="outline" key="close" onClick={onClose}>关闭</Button>}
    >
      <pre className="smp-preview" key="body">{skill.body ?? ''}</pre>
    </Modal>
  )
}
