/**
 * Discover skills already on disk.
 *
 * The panel writes its own entries into `config.skills[]`, but DSH's filesystem
 * provider also reads skills placed by other tools. This module scans the same
 * roots (same names and same precedence) so the panel can list them too.
 *
 * Roots, in DSH's order (first wins for a duplicate name):
 *   project-dsh    <projectRoot>/.dsh/skills
 *   project-agents <projectRoot>/.agents/skills
 *   user-dsh       <dshHome>/skills
 *   user-agents    <agentsHome>/skills
 *
 * A root contains either directory bundles (`<name>/SKILL.md`) or flat files
 * (`<name>.md`), matching what the DSH provider accepts.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** The scan roots for one or more project roots plus the user-level roots. */
export function skillRootsFor({ projectRoots = [], dshHome = '', agentsHome = '' }) {
  const roots = []
  for (const projectRoot of projectRoots) {
    if (projectRoot === '') continue
    roots.push({ path: join(projectRoot, '.dsh/skills'), source: 'project-dsh', scope: projectRoot })
    roots.push({ path: join(projectRoot, '.agents/skills'), source: 'project-agents', scope: projectRoot })
  }
  if (dshHome !== '') roots.push({ path: join(dshHome, 'skills'), source: 'user-dsh', scope: 'global' })
  if (agentsHome !== '') roots.push({ path: join(agentsHome, 'skills'), source: 'user-agents', scope: 'global' })
  return roots
}

/** `name`/`description` from a SKILL.md frontmatter block (best effort). */
export function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(markdown ?? ''))
  if (match === null) return {}
  try {
    const parsed = parseYaml(match[1])
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Bytes of SKILL.md body returned on demand for the preview dialog. */
const BODY_LIMIT = 20000

/** The markdown body without the frontmatter block, capped for the projection. */
export function bodyOf(markdown) {
  const text = String(markdown ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  if (text.length <= BODY_LIMIT) return text
  return `${text.slice(0, BODY_LIMIT)}\n\n…（已截断，完整内容见文件）`
}

/** Read one directory bundle or flat markdown file into a skill record. */
async function readSkillFile(file, name, base) {
  const text = await readFile(file, 'utf8')
  const meta = parseFrontmatter(text)
  return {
    name: typeof meta.name === 'string' && meta.name !== '' ? meta.name : name,
    description: typeof meta.description === 'string' ? meta.description : '',
    path: file,
    source: base.source,
    scope: base.scope,
  }
}

/** Scan one root; a missing root simply yields nothing. */
export async function scanSkillRoot(root) {
  let entries = []
  try {
    entries = await readdir(root.path, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      const file = join(root.path, entry.name, 'SKILL.md')
      try {
        found.push(await readSkillFile(file, entry.name, root))
      } catch {
        // a directory without SKILL.md is not a skill
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      try {
        found.push(await readSkillFile(join(root.path, entry.name), entry.name.replace(/\.md$/, ''), root))
      } catch {
        // unreadable file: skip
      }
    }
  }
  return found
}

/** Scan every root; duplicates keep the first (more specific) one. */
export async function discoverSkills(options) {
  const seen = new Set()
  const out = []
  for (const root of skillRootsFor(options)) {
    for (const skill of await scanSkillRoot(root)) {
      const key = `${skill.scope}\u0000${skill.name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(skill)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
