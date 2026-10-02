import { field } from './field.jsx'

/**
 * Add / edit a skill, using DSH's own Modal so it matches the built-in dialogs.
 *
 * The 区域 (which root the skill is written to) is chosen when adding and shown
 * read-only when editing — moving a skill between roots is a different operation
 * that this panel deliberately does not do behind your back.
 */
export function skillDialogView({
  dialog, draft, roots = [], error = '', pending = false, primitives,
  onRegion, onName, onDescription, onBody, onCancel, onSave,
}) {
  if (dialog === null || dialog === undefined) return null
  const Modal = primitives?.Modal
  if (Modal === undefined) return null
  const Button = primitives.Button ?? 'button'
  const isEdit = dialog.mode === 'edit'
  const rootLabel = (root) => `${root.scope === 'global' ? '全局' : '项目级'} · ${root.id}`
  return (
    <Modal
      open
      onClose={onCancel}
      closeLabel="关闭"
      title={isEdit ? `编辑技能「${dialog.prevName}」` : '添加技能'}
      description={isEdit
        ? `区域不可修改。改名会同时移动目录并重写 SKILL.md 里的 name（原目录会先备份）。`
        : '选择区域后写入 <区域>/<名字>/SKILL.md；目录不存在会自动创建。'}
      footer={
        <>
          <Button variant="outline" key="cancel" onClick={onCancel}>取消</Button>
          <Button variant="primary" key="save" disabled={pending} onClick={onSave}>
            {isEdit ? '保存' : '创建'}
          </Button>
        </>
      }
    >
      <div className="smp-formGrid" key="grid">
        {field('区域', (
          <select
            className="smp-select" value={dialog.regionKey} disabled={isEdit}
            onChange={(event) => onRegion(event.target.value)}
          >
            {roots.map((root) => (
              <option value={`${root.scope}:${root.id}`} key={`${root.scope}:${root.id}`}>{rootLabel(root)}</option>
            ))}
          </select>
        ))}
        {field('名称（会成为目录名）', (
          <input className="smp-input" value={draft.name ?? ''} placeholder="例如 my-skill"
                 onChange={(event) => onName(event.target.value)} />
        ))}
        {field('描述', (
          <input className="smp-input" value={draft.description ?? ''} placeholder="一句话说明何时使用它"
                 onChange={(event) => onDescription(event.target.value)} />
        ))}
        {field('正文（SKILL.md 的内容）', (
          <textarea className="smp-textarea" rows={8} value={draft.body ?? ''}
                    onChange={(event) => onBody(event.target.value)} />
        ), true)}
      </div>
      {error !== '' ? <div className="smp-error" key="err" style={{ marginTop: 8 }}>{error}</div> : null}
    </Modal>
  )
}
