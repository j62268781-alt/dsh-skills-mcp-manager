/**
 * Host-half smoke test: load the built plugin the way DSH does and feed it a real
 * request through the skill channel, asserting that nothing throws.
 *
 * Why this exists: an uncaught exception during plugin load makes DSH treat the
 * profile as broken and run `sanitizeProfile`, which quarantines the user's whole
 * cordis.patch.yml and disables every non-recovery plugin. Compiling and unit
 * tests cannot see that class of bug — only running the code path can.
 *
 * The plugin imports @deepseek-ai/* packages that only exist next to the app, so
 * we stage a package dir whose node_modules/@deepseek-ai points at the app's.
 */
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const appNodeModules = [
  process.env.DSH_APP_NODE_MODULES,
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules',
  '/tmp/dshroot/dsh/node_modules',
// The candidate must be able to resolve the plugin's own dependencies, not just
// contain an @deepseek-ai folder: the app bundle ships a trimmed set.
].find((dir) => dir !== undefined && existsSync(join(dir, '@deepseek-ai', 'schemastery')))

if (appNodeModules === undefined) {
  console.log('  · 跳过 Host 冒烟（找不到 app 的 node_modules，可用 DSH_APP_NODE_MODULES 指定）')
  process.exit(0)
}

execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })

// Stage inside the workspace's node_modules so the plugin's own third-party deps
// (yaml) resolve naturally; only @deepseek-ai/* has to come from the app.
const stage = join(root, 'node_modules', '@local', 'dsh-smoke-stage')
const scopeLink = join(root, 'node_modules', '@deepseek-ai')
const createdScopeLink = !existsSync(scopeLink)
await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })
if (createdScopeLink) await symlink(join(appNodeModules, '@deepseek-ai'), scopeLink, 'dir')
const problems = []
const note = (ok, label) => {
  console.log((ok ? '    ✓ ' : '    ✗ ') + label)
  if (!ok) problems.push(label)
}

let escaped = null
process.on('uncaughtException', (error) => { escaped = 'uncaughtException: ' + error.message })
process.on('unhandledRejection', (error) => { escaped = 'unhandledRejection: ' + (error?.message ?? error) })

try {
  const pkgDir = stage
  await cp(join(root, 'dist'), join(pkgDir, 'dist'), { recursive: true })
  await cp(join(root, 'package.json'), join(pkgDir, 'package.json'))

  const home = join(stage, 'home')
  await mkdir(home, { recursive: true })
  process.env.DSH_HOME = home
  process.env.DSH_AGENTS_HOME = join(stage, 'agents')

  const live = {
    skillRequest: { op: 'create', scope: 'global', id: 'dsh', project: '', name: 'smoke-skill', prevName: '', description: '冒烟', body: '# 冒烟正文', nonce: 'smoke-nonce' },
    skillResult: { ok: false, reason: '', name: '', nonce: '' },
    servers: [], skills: [], rowOps: [], rowOpsReady: false,
    importRequest: { source: '', scope: '', project: '', nonce: '' },
    importResult: { nonce: '', files: [], servers: [], error: '' },
  }
  const noop = () => {}
  const mod = await import(pathToFileURL(join(pkgDir, 'dist', 'index.js')).href)
  const ctx = {
    logger: { info: noop, warn: noop, error: (...args) => problems.push('host logger.error: ' + args.map(String).join(' ')) },
    get: (name) => (name === 'workspaceRegistry' ? { list: () => [] } : undefined),
    loader: { entries: () => [] },
    effect: (fn) => { fn(); return noop },
    plugin: () => ({ dispose: noop }),
    on: () => noop,
    inject: (names, cb) => cb({
      settings: { update: async (ns, patch) => { Object.assign(live, patch); return true } },
      effect: (fn) => { fn(); return noop },
    }),
  }
  const config = {
    servers: { get: () => live.servers }, skills: { get: () => live.skills }, rowOps: { get: () => live.rowOps },
    skillRequest: { get: () => live.skillRequest }, skillResult: { get: () => live.skillResult },
    profileServers: { get: () => [] }, workspaces: { get: () => [] }, currentWorkspace: { get: () => '' },
    importRequest: { get: () => live.importRequest }, importResult: { get: () => live.importResult },
  }

  try {
    mod.apply(ctx, config)
    await new Promise((resolveWait) => setTimeout(resolveWait, 3000))
  } catch (error) {
    escaped = 'apply threw: ' + error.message
  }

  note(escaped === null, '没有异常逃逸出插件（' + (escaped ?? '干净') + '）')
  note(live.skillResult.ok === true, 'skillResult.ok = true（收到处理结果）')
  note(live.skillRequest.nonce === '', '处理完清空了 skillRequest（防止重启重放）')
  const file = join(home, 'skills', 'smoke-skill', 'SKILL.md')
  note(existsSync(file), '技能文件确实写到磁盘')

  // Send one op and wait for its own receipt (the Host clears the request).
  const sendSkill = async (request, waitMs = 1800) => {
    live.skillResult = { ok: false, reason: '', name: '', nonce: '' }
    live.skillRequest = {
      op: '', scope: 'global', id: 'dsh', project: '', name: '', prevName: '',
      description: '', body: '', ...request,
      nonce: `probe-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, waitMs))
    return live.skillResult
  }

  // update: same name, new content — the panel edits in place.
  const updated = await sendSkill({ op: 'update', name: 'smoke-skill', description: '冒烟', body: '# 改后正文' })
  note(updated.ok === true && readFileSync(file, 'utf8').includes('# 改后正文'), 'update 通道就地改写正文')

  // rename: the user's actual question — does the folder move too? It must,
  // because DSH takes the name from the frontmatter but treats the directory as
  // the skill's resource base.
  const renamed = await sendSkill({ op: 'rename', name: 'smoke-renamed', prevName: 'smoke-skill', description: '冒烟', body: '# 改后正文' })
  const oldDir = join(home, 'skills', 'smoke-skill')
  const newDir = join(home, 'skills', 'smoke-renamed')
  const newFile = join(newDir, 'SKILL.md')
  note(renamed.ok === true && !existsSync(oldDir) && existsSync(newFile), 'rename 把目录一起改名（旧目录消失、新目录存在）')
  if (existsSync(newFile)) {
    const text = readFileSync(newFile, 'utf8')
    note(/name:\s*smoke-renamed/.test(text), 'rename 同步改写了 frontmatter 的 name')
  } else {
    note(false, 'rename 后读不到新目录的 SKILL.md')
  }
  const backups = existsSync(join(home, 'skills')) ? readdirSync(join(home, 'skills')).filter((name) => name.startsWith('.smp-backup-')) : []
  note(backups.length > 0, `rename 之前留了备份（${backups.length} 个 .smp-backup-*）`)
  note((await sendSkill({ op: 'create', name: 'smoke-renamed', body: 'x' })).ok === false, '同名再创建被拒绝（不覆盖既有技能）')

  // Channel 2: importRequest -> importResult (a bogus source must come back as a
  // result, never as a thrown error).
  live.importRequest = { source: 'not-a-real-source', scope: 'global', project: '', nonce: 'import-probe' }
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
  note(live.importResult?.nonce === 'import-probe', 'importRequest 通道有回执（nonce 原样返回）')

  // Channel 3: rowOps drain. applyRowOp cannot work here (no profileContext), so
  // this asserts the drain *contains* the failure instead of letting it escape.
  live.rowOps = [{ op: 'toggle', entryId: 'mcp-does-not-exist', enabled: false }]
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
  note(Array.isArray(live.rowOps) && live.rowOps.length === 0, 'rowOps 被排空（失败被记录而非逃逸）')
} catch (error) {
  note(false, '冒烟脚本自身出错：' + error.message)
} finally {
  process.removeAllListeners('uncaughtException')
  process.removeAllListeners('unhandledRejection')
  await rm(stage, { recursive: true, force: true })
  if (createdScopeLink) await rm(scopeLink, { force: true })
}

if (problems.length > 0) {
  console.log('  ✗ Host 冒烟失败：' + problems.join(' | '))
  process.exit(1)
}
console.log('  ✓ Host 冒烟通过：加载 / apply / skillRequest / importRequest / rowOps 排空 全部正常')
process.exit(0)
