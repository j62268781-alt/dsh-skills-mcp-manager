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

/**
 * Local identity of a discovered skill: its name plus the scope key the settings
 * document uses (`global`, or a project path). A delete is bookkept against
 * exactly this pair, so rendering can filter the card out until the document
 * itself catches up.
 */
export function removalTargetOf(skill = {}) {
  const name = String(skill?.name ?? '')
  const scope = typeof skill?.scope === 'string' && skill.scope !== '' ? skill.scope : 'global'
  return { name, scopeKey: scope === 'global' ? 'global' : scope }
}

/**
 * Drop the optimistic card a panel-created skill left behind.
 *
 * The create path inserts a card immediately and keeps it in local state; once
 * the document lists it that card is simply filtered out. When the skill is
 * deleted again the document stops listing it, which made that stale optimistic
 * entry visible again as a ghost card (「删了卡片还在」). A delete receipt means
 * the entry must not come back, so it is dropped here — on failure too: if the
 * skill really is still on disk the document lists it and the normal card comes
 * back on its own.
 */
export function dropOptimisticSkill(optimistic = [], name) {
  const wanted = String(name ?? '')
  if (wanted === '') return optimistic
  const next = optimistic.filter((entry) => entry.name !== wanted)
  return next.length === optimistic.length ? optimistic : next
}

/**
 * Hide every card matching `name::scopeKey` until the settings document stops
 * listing it. The renderer's snapshot can lag the Host by seconds, so a deleted
 * card would otherwise stay on screen.
 */
export function hideSkillUntilGone(removedKeys = [], name, scopeKey) {
  const wanted = String(name ?? '')
  if (wanted === '') return removedKeys
  const key = `${wanted}::${scopeKey === undefined || scopeKey === '' ? 'global' : scopeKey}`
  if (removedKeys.includes(key)) return removedKeys
  return [...removedKeys, key]
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
