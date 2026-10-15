import { field } from './field.jsx'

/**
 * Add / edit a skill, using DSH's own Modal so it matches the built-in dialogs.
 *
 * ## Three orthogonal choices, not one flat list
 *
 * The destination used to be a single 「区域」 dropdown listing all four roots. That worked but
 * conflated three *different* questions, and the list grew a second entry for every workspace:
 *
 *   1. **层级** — 全局（所有工作区都用）还是项目级（只在某个工作区）
 *   2. **工作区** — 项目级写到哪一个（从注册表选，也可以手填绝对路径，与 MCP 的写法一致）
 *   3. **目录** — `.dsh/skills` 还是 `.agents/skills`（DSH 的 provider 两个都读）
 *
 * Splitting them means the dialog stays three fields no matter how many workspaces exist, and
 * each choice says one thing. The resolved absolute path is shown underneath, so the answer to
 * "where will this land" is still visible at a glance rather than implied.
 *
 * Editing keeps all three read-only: moving a skill between roots is a different operation that
 * this panel deliberately does not do behind your back.
 */
export function skillDialogView({
  dialog, draft, workspaceChoices = [], resolvedPath = '', error = '', pending = false, primitives,
  onScope, onProject, onProjectCustom, onRoot, onName, onDescription, onBody, onCancel, onSave,
}) {
  if (dialog === null || dialog === undefined) return null
  const Modal = primitives?.Modal
  if (Modal === undefined) return null
  const Button = primitives.Button ?? 'button'
  const isEdit = dialog.mode === 'edit'
  /**
   * Project-level writes need a workspace; a global one does not — asking for a path when the
   * destination is a user-level root would be a field with no effect.
   */
  const isProject = dialog.scope === 'project'
  /** The workspace picker is a dropdown until the user picks 「自定义路径…」. */
  const custom = dialog.projectCustom === true
  return (
    <Modal
      open
      onClose={onCancel}
      closeLabel="关闭"
      title={isEdit ? `编辑技能「${dialog.prevName}」` : '添加技能'}
      description={isEdit
        ? '层级、工作区与目录都不可修改。改名会同时移动目录并重写 SKILL.md 里的 name（原目录会先备份）。'
        : '选择层级与目录后写入 <目标目录>/<名字>/SKILL.md；目录不存在会自动创建。'}
      footer={
        <>
          <Button variant="outline" key="cancel" onClick={onCancel}>取消</Button>
          <Button variant="primary" key="save" disabled={pending} onClick={onSave}>
            {pending ? '保存中…' : (isEdit ? '保存' : '创建')}
          </Button>
        </>
      }
    >
      <div className="smp-skillDialogBody" key="body">
      <div className="smp-formGrid" key="grid">
        {field('层级', (
          <select
            className="smp-select" value={dialog.scope} disabled={isEdit}
            onChange={(event) => onScope(event.target.value)}
          >
            <option value="global" key="g">全局 —— 所有工作区都能用</option>
            <option value="project" key="p">项目级 —— 只在某个工作区</option>
          </select>
        ))}
        {/*
          Only meaningful for a project entry. Kept in the same position as the tier field above
          so switching tiers does not reshuffle the form, and mirroring MCP's scope picker
          (registry entries plus 「自定义路径…」) so both dialogs are learned once.
        */}
        {!isProject ? null : field('工作区', (
          <div className="smp-scopePick" key="workspace">
            <select
              className="smp-select" key="sel" disabled={isEdit}
              value={custom ? '__custom__' : (dialog.project ?? '')}
              onChange={(event) => onProject(event.target.value)}
            >
              <option value="" key="none">请选择工作区</option>
              {workspaceChoices.map(([path, title]) => <option value={path} key={path}>{title}</option>)}
              <option value="__custom__" key="custom">自定义路径…</option>
            </select>
            {!custom ? null : (
              <input
                className="smp-input" key="custom" disabled={isEdit}
                placeholder="工作区绝对路径"
                value={dialog.project ?? ''}
                onChange={(event) => onProjectCustom(event.target.value)}
              />
            )}
          </div>
        ), true)}
        {field('目录', (
          <select
            className="smp-select" value={dialog.id === 'agents' ? 'agents' : 'dsh'} disabled={isEdit}
            onChange={(event) => onRoot(event.target.value)}
          >
            <option value="dsh" key="d">.dsh/skills</option>
            <option value="agents" key="a">.agents/skills</option>
          </select>
        ))}
        {/*
          The resolved absolute path. The three choices above are what the user thinks in; this
          line is the fact — DSH reads both roots, and a project path is resolved to the nearest
          enclosing project root, so the path here is what will actually be written.
        */}
        {resolvedPath === '' ? null : (
          // `.smp-skillPath` spans both grid columns (it is not a `.smp-field`, so the
          // `data-wide` convention does not apply to it).
          <p className="smp-note smp-skillPath" key="resolved">
            {`将写入 ${resolvedPath}/<名字>/SKILL.md`}
          </p>
        )}
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
      {pending ? (
        <div className="smp-pendingHint" key="pending">正在与磁盘同步…</div>
      ) : null}
      {error !== '' ? <div className="smp-error" key="err" style={{ marginTop: 8 }}>{error}</div> : null}
      </div>
    </Modal>
  )
}
