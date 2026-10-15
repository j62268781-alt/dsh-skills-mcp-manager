/**
 * Heartbeat file: a small JSON breadcrumb the panel writes so the Host's state
 * (tick, row ops, mounts) can be inspected from outside the app.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHome } from '../runtime/env.js'

export const beatFile = () => join(dshHome(), 'dsh-skills-mcp-manager.heartbeat.json')

export async function beat(payload) {
  try {
    await mkdir(dirname(beatFile()), { recursive: true })
    await writeFile(beatFile(), `${JSON.stringify(payload, null, 2)}\n`)
  } catch (error) {
    if (process.env.SMP_DEBUG) console.error(`[dsh-skills-mcp-manager] %s`, error)
  }
}

/** Create or update every enabled skill, then delete files this plugin owned before. */
