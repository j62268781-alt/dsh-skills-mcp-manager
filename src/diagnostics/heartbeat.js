/**
 * Heartbeat file: a small JSON breadcrumb the panel writes so the Host's state
 * (tick, row ops, mounts) can be inspected from outside the app.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHome } from '../runtime/env.js'

export const beatFile = () => join(dshHome(), 'skills-mcp-panel.heartbeat.json')

export async function beat(payload) {
  try {
    await mkdir(dirname(beatFile()), { recursive: true })
    await writeFile(beatFile(), `${JSON.stringify(payload, null, 2)}\n`)
  } catch {
    // diagnostics never break the plugin
  }
}

/** Create or update every enabled skill, then delete files this plugin owned before. */
