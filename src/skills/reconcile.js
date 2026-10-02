/**
 * DSH skills on disk: the panel mirrors `config.skills[]` into
 * `$DSH_HOME/skills/<name>/SKILL.md` (global) or `<project>/.agents/skills/...`
 * (project), and removes directories that are no longer configured.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { dshHome } from '../runtime/env.js'

const stateFile = () => join(dshHome(), 'skills-mcp-panel.state.json')

/** Nearest ancestor holding `.git` — the same project-root rule as the skill provider. */
export function projectRootOf(dir) {
  let current = resolve(dir)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(dir)
    current = parent
  }
}

/** The skills directory one scope writes into. */
export function scopeRoot(scope) {
  return scope === 'global' ? join(dshHome(), 'skills') : join(projectRootOf(scope), '.agents', 'skills')
}

/** Frontmatter plus body, exactly what the filesystem skill provider parses. */
export function renderSkill(skill) {
  const description = skill.description || skill.name
  return `---\nname: ${skill.name}\ndescription: ${description}\n---\n\n${(skill.body || '').trim()}\n`
}

export async function readState() {
  try {
    return JSON.parse(await readFile(stateFile(), 'utf8'))
  } catch {
    return { files: [] }
  }
}

/**
 * Diagnostics: every tick records what it observed and what it did, so the
 * running app can be inspected without a console. Remove once the volatile
 * config read path is proven stable.
 */
export async function reconcileSkills(ctx, skills) {
  const wanted = new Map()
  for (const skill of skills) {
    if (skill.enabled === false || !skill.name) continue
    wanted.set(join(scopeRoot(skill.scope), skill.name, 'SKILL.md'), renderSkill(skill))
  }

  const previous = await readState()
  const owned = []
  const result = { wanted: [...wanted.keys()], written: [], kept: [], removed: [], failed: [] }

  for (const [path, text] of wanted) {
    try {
      const current = await readFile(path, 'utf8').catch(() => undefined)
      if (current !== text) {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, text)
        result.written.push(path)
        ctx.logger.info('skills-mcp-panel: wrote %s', path)
      } else {
        result.kept.push(path)
      }
      owned.push(path)
    } catch (error) {
      result.failed.push(`${path}: ${error?.message ?? error}`)
      ctx.logger.error('skills-mcp-panel: cannot write %s', path)
      ctx.logger.error(error)
    }
  }

  for (const path of previous.files ?? []) {
    if (wanted.has(path)) continue
    try {
      await rm(dirname(path), { recursive: true, force: true })
      result.removed.push(path)
      ctx.logger.info('skills-mcp-panel: removed %s', dirname(path))
    } catch (error) {
      result.failed.push(`${path}: ${error?.message ?? error}`)
      ctx.logger.warn('skills-mcp-panel: cannot remove %s', path)
    }
  }
  try {
    await mkdir(dirname(stateFile()), { recursive: true })
    await writeFile(stateFile(), `${JSON.stringify({ files: owned }, null, 2)}\n`)
  } catch (error) {
    if (process.env.SMP_DEBUG) console.error('[skills-mcp-panel] cannot write skill state', error)
  }
  return result
}
