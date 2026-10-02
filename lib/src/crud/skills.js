/**
 * Skills CRUD: turning panel drafts into `config.skills[]` entries.
 *
 * A skill entry carries its own `scope` — either the literal `'global'` or a
 * project path — because the Host mirrors each entry into that scope's
 * `.agents/skills` (or `$DSH_HOME/skills`) directory. Pure functions, no React.
 */

/** The scope a skill belongs to: `'global'` or a project path. */
export function scopeOfSkill(skill) {
  return typeof skill?.scope === 'string' && skill.scope !== '' ? skill.scope : 'global'
}

/** Entries belonging to one scope. */
export function skillsForScope(skills = [], scope) {
  return skills.filter((skill) => scopeOfSkill(skill) === scope)
}

/** Build/replace an entry from the form draft. */
export function skillEntryOf(draft, scope) {
  return {
    name: (draft.name ?? '').trim(),
    description: (draft.description ?? '').trim(),
    body: typeof draft.body === 'string' ? draft.body : '',
    scope: scope === '' ? 'global' : scope,
    enabled: draft.enabled === false ? false : true,
  }
}

/** Insert or replace (by identity) an entry. */
export function upsertSkill(skills = [], entry, existing = null) {
  return existing === null ? [...skills, entry] : skills.map((item) => (item === existing ? entry : item))
}

/** Insert or replace by identity key (name + scope) — what the panel edit form does. */
export function upsertSkillByName(skills = [], entry) {
  const scope = scopeOfSkill(entry)
  return [
    ...skills.filter((item) => !(item.name === entry.name && scopeOfSkill(item) === scope)),
    entry,
  ]
}

/** Remove an entry by identity. */
export function removeSkill(skills = [], entry) {
  return skills.filter((item) => item !== entry)
}

/** Name-only search (the panel deliberately ignores description/body). */
export function matchesSkillName(skill, query) {
  const needle = (query ?? '').trim().toLowerCase()
  if (needle === '') return true
  return (skill?.name ?? '').toLowerCase().includes(needle)
}

/** A draft for editing an existing entry. */
export function skillDraftFrom(skill) {
  return {
    name: skill?.name ?? '',
    description: skill?.description ?? '',
    body: skill?.body ?? '',
    enabled: skill?.enabled !== false,
  }
}

/** Whether a skill name is acceptable (matches the Host's validation). */
export function isValidSkillName(name) {
  return /^[A-Za-z0-9_-]{1,64}$/.test((name ?? '').trim())
}
