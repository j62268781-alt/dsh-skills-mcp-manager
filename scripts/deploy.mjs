/**
 * Install this bundle into the desktop profile.
 *
 * A copy — not a symlink — on purpose: Node resolves a symlinked package to its
 * real path, and the Host half imports `@deepseek-ai/*` which only exist inside
 * the profile's node_modules. The previous install is kept as a timestamped
 * backup so a bad build can be rolled back by renaming it back.
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const source = resolve(import.meta.dirname, '..')
const profile = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const target = join(profile, 'node_modules', '@local', 'dsh-skills-mcp-panel')

// Safety: only ever touch this exact package inside the profile.
if (!target.endsWith(join('node_modules', '@local', 'dsh-skills-mcp-panel'))) {
  throw new Error(`refusing to deploy to unexpected path: ${target}`)
}
if (!existsSync(profile)) throw new Error(`profile not found: ${profile}`)

if (existsSync(target)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${target}.backup-${stamp}`
  renameSync(target, backup)
  console.log(`  · 旧版本已备份: ${backup}`)
}
mkdirSync(dirname(target), { recursive: true })
cpSync(source, target, {
  recursive: true,
  filter: (src) => !/^(node_modules|\.git|\.scaffold-panel|test|scripts|lib\/src|src)(\/|$)|^(esbuild\.config\.mjs|tsconfig\.json|test-.*\.mjs|verify-.*\.mjs)$/.test(src.slice(source.length + 1)),
})
console.log(`  ✓ 已部署到 ${target}`)
console.log('  · 重启 DSH 后生效（Host 半需要重启，Client 半刷新即可）')
