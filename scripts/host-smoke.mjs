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
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
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
const stage = join(root, 'node_modules', 'dsh-smoke-stage')
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
  // A skill on disk up front, so the discovery channel has something to publish.
  await mkdir(join(home, 'skills', 'smoke-discovered'), { recursive: true })
  await writeFile(join(home, 'skills', 'smoke-discovered', 'SKILL.md'),
    '---\nname: smoke-discovered\ndescription: 发现通道冒烟\n---\n\n# 发现\n')
  await mkdir(join(home, 'stagingMarker'), { recursive: true })

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
      settings: { update: async (ns, patch) => { live.__updates = (live.__updates ?? 0) + 1; Object.assign(live, patch); return true } },
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

  // Channel 4: disk-skill discovery. This is where the real app silently published
  // an empty list, so the smoke must prove the channel actually publishes.
  const discovered = Array.isArray(live.discoveredSkills) ? live.discoveredSkills : []
  note(discovered.some((skill) => skill.name === 'smoke-discovered'), '磁盘技能发现通道发布了 staged 技能')
  // The list must stay small: bodies are fetched on demand, never published here.
  note(discovered.every((skill) => skill.body === undefined), '列表不夹带正文（体积不会随技能数膨胀）')

  // A write channel that never reaches settings (self-recursion, early return) used
  // to pass every other assertion, so assert the writes actually happened.
  note((live.__updates ?? 0) > 0, 'Host 确实调用了 settings.update（写入通道真的在工作）')

  // `projectRootOf` walks up to the nearest ancestor holding `.git`, so the staged
  // project needs that marker or the skill lands in some unrelated ancestor.
  await mkdir(join(stage, '.git'), { recursive: true })

  // Project-level create must land on disk under <project>/.agents/skills.
  const projNonce = String(Date.now())
  live.skillResult = { ok: false, reason: '', name: '', nonce: '' }
  live.skillRequest = { op: 'create', scope: 'project', id: 'agents', project: stage, path: '', name: 'smoke-project-skill', prevName: '', description: '项目级冒烟', body: '# 项目级\n', nonce: projNonce }
  const projStart = Date.now()
  while (Date.now() - projStart < 2000 && live.skillResult?.nonce !== projNonce) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const projFile = join(stage, '.agents', 'skills', 'smoke-project-skill', 'SKILL.md')
  note(live.skillResult?.nonce === projNonce && live.skillResult?.ok === true, '项目级创建回执成功且 nonce 原样返回')
  note(existsSync(projFile), '项目级技能落盘到 <project>/.agents/skills/<name>/SKILL.md')
  // Latency guard AND metric: the op must publish at once. Waiting for the 5s
  // publish timer is what made a save take ~4.6s to appear in the panel.
  const publishStart = Date.now()
  let publishMs = -1
  while (Date.now() - publishStart < 2000) {
    if (Array.isArray(live.discoveredSkills) && live.discoveredSkills.some((s) => s.name === 'smoke-project-skill')) {
      publishMs = Date.now() - publishStart
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  note(publishMs >= 0 && publishMs < 400,
    `操作后立即发布（列表数据 ${publishMs}ms 内可见，无需等 5 秒周期）`)

  // Delete: the card's spinner is driven by the receipt, its disappearance by the
  // published list — so both must land, and just as fast. A missing receipt left
  // 「删除中…」 spinning forever, and a stale list left the card in place.
  const delNonce = String(Date.now())
  live.skillResult = { ok: false, reason: '', name: '', nonce: '' }
  live.skillRequest = { op: 'delete', scope: 'project', id: 'agents', project: stage, path: projFile, name: 'smoke-project-skill', prevName: '', description: '', body: '', nonce: delNonce }
  const delStart = Date.now()
  let delMs = -1
  while (Date.now() - delStart < 2000) {
    const listed = Array.isArray(live.discoveredSkills) && live.discoveredSkills.some((s) => s.name === 'smoke-project-skill')
    if (live.skillResult?.nonce === delNonce && live.skillResult?.ok === true && !listed) {
      delMs = Date.now() - delStart
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  note(live.skillResult?.nonce === delNonce && live.skillResult?.ok === true, '删除回执成功且 nonce 原样返回')
  note(!existsSync(projFile), '删除后 SKILL.md 真的从磁盘消失')
  // The budget to beat is the 5s periodic publish; the delete itself re-scans the
  // roots before republishing, so it is not held to the create path's 400ms.
  note(delMs >= 0 && delMs < 1500,
    `删除后列表在回执同轮就已更新（实测 ${delMs}ms，未等 5 秒周期）`)

  // Deleting an already-deleted skill must still answer: a silent no-answer is
  // what made the panel's card spin forever instead of reporting 「不存在」.
  const againNonce = String(Date.now())
  live.skillResult = { ok: false, reason: '', name: '', nonce: '' }
  live.skillRequest = { op: 'delete', scope: 'project', id: 'agents', project: stage, path: projFile, name: 'smoke-project-skill', prevName: '', description: '', body: '', nonce: againNonce }
  const againStart = Date.now()
  while (Date.now() - againStart < 2000 && live.skillResult?.nonce !== againNonce) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  note(live.skillResult?.nonce === againNonce && live.skillResult?.ok === false,
    '重复删除同样有回执（ok=false + 原因，卡片不会一直空转）')
  note(live.skillRequest?.nonce === '', '删除处理完清空了请求（防重启重放）')

  // Channel 5: on-demand body read. The preview asks for the file by path and the
  // Host verifies that path came from the latest scan before reading it.
  const target = discovered.find((skill) => skill.name === 'smoke-discovered')
  // Poll: the Host drains its request channel on a 600ms timer, so a fixed short
  // wait is a coin flip (and made this suite flaky under any timing change).
  const readNonce = String(Date.now())
  live.skillResult = { ok: false, reason: '', name: '', nonce: '' }
  live.skillRequest = { op: 'read', scope: '', id: '', project: '', path: target?.path ?? '', name: '', prevName: '', description: '', body: '', nonce: readNonce }
  const readStart = Date.now()
  while (Date.now() - readStart < 2000 && live.skillResult?.nonce !== readNonce) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const readResult = live.skillResult ?? {}
  note(readResult.nonce === readNonce && readResult.ok === true, 'read 通道回执成功（按需读取正文）')
  note(typeof readResult.body === 'string' && readResult.body.includes('发现'), 'read 通道返回了正文内容')
  note(live.skillRequest?.nonce === '', 'read 处理完清空了请求（防重放）')

  // Regression guard for the reported bug: previewing a skill must not shrink the
  // discovered list (a `read` used to re-scan with the request's own empty roots).
  const beforeRead = Array.isArray(live.discoveredSkills) ? live.discoveredSkills.length : -1
  const shrinkNonce = String(Date.now())
  live.skillResult = { ok: false, reason: '', name: '', nonce: '' }
  live.skillRequest = { op: 'read', scope: '', id: '', project: '', path: target?.path ?? '', name: '', prevName: '', description: '', body: '', nonce: shrinkNonce }
  const shrinkStart = Date.now()
  while (Date.now() - shrinkStart < 2000 && live.skillResult?.nonce !== shrinkNonce) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const afterRead = Array.isArray(live.discoveredSkills) ? live.discoveredSkills.length : -1
  note(beforeRead > 0 && afterRead === beforeRead, `预览(read)不会让列表缩水（${beforeRead} → ${afterRead}）`)
  note(typeof live.discoveryInfo?.at === 'string' && live.discoveryInfo.at !== '', 'discoveryInfo 记录了扫描时间（诊断通道可用）')
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
console.log('  ✓ Host 冒烟通过：加载 / skillRequest / importRequest / rowOps 排空 / 磁盘技能发现 / 按需读正文 全部正常')
process.exit(0)
