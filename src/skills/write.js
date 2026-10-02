/**
 * Writing skills to disk: create, update, rename, delete.
 *
 * A skill is a directory bundle `<root>/<name>/SKILL.md`, so the *name* is both
 * a frontmatter field and the directory name. DSH reads the name from the
 * frontmatter but uses the directory as the skill's resource base, so a rename
 * must move the directory AND rewrite the frontmatter — otherwise the panel and
 * the folder disagree.
 *
 * Safety: names are validated, an existing target is never overwritten, and the
 * previous copy is kept in a dot-prefixed backup directory (dot entries are
 * ignored by both DSH and our own scanner).
 */
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'

/** Writable skill roots, per scope. `id` is what the UI shows as the 区域 tag. */
export function writableRoots({ dshHome = '', agentsHome = '', projectRoot = '' }) {
  const roots = []
  if (dshHome !== '') roots.push({ id: 'dsh', scope: 'global', dir: join(dshHome, 'skills') })
  if (agentsHome !== '') roots.push({ id: 'agents', scope: 'global', dir: join(agentsHome, 'skills') })
  if (projectRoot !== '') {
    roots.push({ id: 'agents', scope: 'project', dir: join(projectRoot, '.agents', 'skills') })
    roots.push({ id: 'dsh', scope: 'project', dir: join(projectRoot, '.dsh', 'skills') })
  }
  return roots
}

/** Names become directory names: reject anything that could escape the root. */
export function validateSkillName(name) {
  const value = String(name ?? '').trim()
  if (value === '') return { ok: false, reason: '名字不能为空' }
  if (value.length > 64) return { ok: false, reason: '名字不能超过 64 个字符' }
  if (value.includes('/') || value.includes('\\')) return { ok: false, reason: '名字不能包含斜杠' }
  if (value === '.' || value === '..' || value.startsWith('.')) return { ok: false, reason: '名字不能以点开头，也不能是 . 或 ..' }
  if (/[\u0000-\u001f]/.test(value)) return { ok: false, reason: '名字不能包含控制字符' }
  return { ok: true, value }
}

/** `SKILL.md` content: frontmatter (name/description) plus the body. */
export function renderSkillMarkdown({ name, description = '', body = '' }) {
  const meta = { name }
  if (String(description).trim() !== '') meta.description = String(description)
  const front = stringifyYaml(meta).trimEnd()
  return `---\n${front}\n---\n\n${String(body).replace(/^\n+/, '')}`
}

const backupDirFor = (root, name) => join(root, `.smp-backup-${name}-${Date.now()}`)

/** Create `<root>/<name>/SKILL.md`; refuses to overwrite an existing skill. */
export async function createSkill({ dir, name, description = '', body = '' }) {
  const checked = validateSkillName(name)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  const target = join(dir, checked.value)
  if (existsSync(target)) return { ok: false, reason: `「${checked.value}」已存在，请换一个名字` }
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'SKILL.md'), renderSkillMarkdown({ name: checked.value, description, body }), 'utf8')
  return { ok: true, name: checked.value, path: join(target, 'SKILL.md') }
}

/** Overwrite an existing skill's SKILL.md (same directory, same name unless renamed). */
export async function updateSkill({ dir, name, description = '', body = '' }) {
  const checked = validateSkillName(name)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  const target = join(dir, checked.value)
  if (!existsSync(target)) return { ok: false, reason: `「${checked.value}」不存在` }
  await writeFile(join(target, 'SKILL.md'), renderSkillMarkdown({ name: checked.value, description, body }), 'utf8')
  return { ok: true, name: checked.value, path: join(target, 'SKILL.md') }
}

/**
 * Rename a skill: move `<dir>/<from>` to `<dir>/<to>` and rewrite the frontmatter
 * name to match. Refuses when the target exists; keeps a backup of the original.
 */
export async function renameSkill({ dir, from, to, description = '', body = '' }) {
  const prev = validateSkillName(from)
  const next = validateSkillName(to)
  if (!prev.ok) return { ok: false, reason: prev.reason }
  if (!next.ok) return { ok: false, reason: next.reason }
  if (prev.value === next.value && existsSync(join(dir, prev.value))) {
    return updateSkill({ dir, name: next.value, description, body })
  }
  const source = join(dir, prev.value)
  const target = join(dir, next.value)
  if (!existsSync(source)) return { ok: false, reason: `「${prev.value}」不存在` }
  if (existsSync(target)) return { ok: false, reason: `「${next.value}」已存在，不会覆盖` }
  const backup = backupDirFor(dir, prev.value)
  await cp(source, backup, { recursive: true })
  await rename(source, target)
  const existing = await readFile(join(target, 'SKILL.md'), 'utf8').catch(() => '')
  const bodyText = String(body) !== '' ? String(body) : stripFrontmatter(existing)
  await writeFile(join(target, 'SKILL.md'), renderSkillMarkdown({ name: next.value, description, body: bodyText }), 'utf8')
  return { ok: true, name: next.value, path: join(target, 'SKILL.md'), backup }
}

/** Remove a skill directory (with a backup first). */
export async function deleteSkill({ dir, name }) {
  const checked = validateSkillName(name)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  const target = join(dir, checked.value)
  if (!existsSync(target)) return { ok: false, reason: `「${checked.value}」不存在` }
  const backup = backupDirFor(dir, checked.value)
  await cp(target, backup, { recursive: true })
  await rm(target, { recursive: true, force: true })
  return { ok: true, name: checked.value, backup }
}

/** Everything after the frontmatter block. */
export function stripFrontmatter(markdown) {
  return String(markdown ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}
