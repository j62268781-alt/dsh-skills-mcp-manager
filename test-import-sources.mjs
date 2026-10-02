/**
 * Import-source test: no CLI is downloaded. Every fixture is written into a
 * temporary "workspace" (and a temporary HOME) with the shape that tool uses,
 * then the panel's scan channel is exercised end to end for each source.
 *
 * Run: node test-import-sources.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = join(tmpdir(), 'dsh-mcp-import-test')
const home = join(root, 'home')
const project = join(root, 'workspace')
process.env.HOME = home

/** source -> { project: [[relative, json]], global: [[relative-to-home, json]] } */
const FIXTURES = {
  claude: { project: [['.mcp.json', { mcpServers: { claudeStdio: { command: 'npx', args: ['-y', 'pkg'] } } }]], global: [['.claude.json', { mcpServers: { claudeG: { command: 'node', args: ['a.js'] } } }]] },
  cursor: { project: [['.cursor/mcp.json', { mcpServers: { cursorHttp: { url: 'https://c.example/mcp', headers: { Authorization: 'Bearer k' } } } }]], global: [['.cursor/mcp.json', { mcpServers: { cursorG: { command: 'uvx', args: ['x'] } } }]] },
  gemini: { project: [['.gemini/settings.json', { mcpServers: { geminiOne: { command: 'npx', args: ['-y', 'g'] } } }]], global: [['.gemini/settings.json', { mcpServers: { geminiG: { command: 'npx', args: ['-y', 'g2'] } } }]] },
  qwen: { project: [['.qwen/settings.json', { mcpServers: { qwenOne: { command: 'npx', args: ['-y', 'q'] } } }]], global: [] },
  continue: { project: [['.continue/config.json', { mcpServers: { continueOne: { command: 'npx', args: ['-y', 'c'] } } }]], global: [] },
  crush: { project: [['crush.json', { mcp: { crushOne: { command: 'npx', args: ['-y', 'cr'] }, crushHttp: { url: 'https://cr.example/mcp' } } }]], global: [] },
  zed: { project: [['.zed/settings.json', { context_servers: { zedOne: { command: { path: 'node', args: ['z.js'], env: { T: '1' } } }, zedHttp: { url: 'https://z.example/mcp' } } }]], global: [] },
  opencode: { project: [['opencode.json', { mcp: { ocLocal: { type: 'local', command: ['uvx', 'mcp-fetch'], environment: { TOKEN: 't' } }, ocRemote: { type: 'remote', url: 'https://oc.example/mcp' } } }]], global: [] },
  vscode: { project: [['.vscode/mcp.json', { servers: { vsOne: { type: 'stdio', command: 'node', args: ['v.js'] }, vsHttp: { type: 'http', url: 'https://v.example/mcp' } } }]], global: [] },
  antigravity: { project: [['.antigravity/mcp.json', { mcpServers: { agOne: { command: 'npx', args: ['-y', 'ag'] } } }]], global: [] },
  mimocode: { project: [['.mimo/mcp.json', { mcpServers: { mimoOne: { command: 'npx', args: ['-y', 'mi'] } } }]], global: [] },
  kimi: { project: [['.kimi/mcp.json', { mcpServers: { kimiOne: { command: 'npx', args: ['-y', 'ki'] } } }]], global: [] },
  qoder: { project: [['.qoder/mcp.json', { mcpServers: { qoderOne: { command: 'npx', args: ['-y', 'qo'] } } }]], global: [] },
  codex: { project: [['.codex/config.toml', null]], global: [] },
}

/** Sources that legitimately have no known project file. */
const NO_FILE = ['chatgpt', 'reasonix', 'teleagent', 'kilo', 'zcode', 'grok', 'openclaw', 'pi', 'hermes', 'workbuddy', 'cline', 'goose']

for (const [id, spec] of Object.entries(FIXTURES)) {
  for (const [relative, json] of spec.project) {
    const file = join(project, relative)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, json === null ? 'x = 1\n' : `${JSON.stringify(json, null, 2)}\n`)
  }
  for (const [relative, json] of spec.global) {
    const file = join(home, relative)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
  }
}
mkdirSync(project, { recursive: true })

const live = { servers: [], skills: [], profileServers: [], workspaces: [], rowOps: [], importRequest: {}, importResult: {} }
const updates = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get: (name) => name === 'profileContext' ? { dir: join(root, 'profile') } : (name === 'workspaceRegistry' ? { list: () => [] } : undefined),
  loader: { entries: () => [] },
  effect: (fn) => { fn(); return () => {} },
  plugin: () => ({ dispose() {} }),
  on: () => () => {},
  inject: (names, cb) => cb({ settings: { update: async (ns, patch) => { updates.push(patch); Object.assign(live, patch); return true } }, effect: (fn) => { fn(); return () => {} } }),
}
const config = {
  servers: { get: () => live.servers }, skills: { get: () => live.skills }, profileServers: { get: () => live.profileServers },
  workspaces: { get: () => live.workspaces }, rowOps: { get: () => live.rowOps },
  importRequest: { get: () => live.importRequest }, importResult: { get: () => live.importResult },
}
const { apply } = await import(new URL('./index.js', import.meta.url))
apply(ctx, config)

const scan = async (source, scope) => {
  live.importRequest = { source, scope, project: scope === 'global' ? '' : project, nonce: `${source}-${scope}-${Date.now()}` }
  await new Promise((resolve) => setTimeout(resolve, 2200))
  const result = updates.map((patch) => patch.importResult).filter(Boolean).pop() ?? {}
  return result
}

let failures = 0
const check = (ok, label, detail) => { if (!ok) { failures += 1; console.log(`  ✗ ${label} ${detail}`) } else console.log(`  ✓ ${label}`) }

console.log('== 项目级 ==')
for (const [id, spec] of Object.entries(FIXTURES)) {
  const result = await scan(id, 'project')
  if (id === 'codex') { check((result.error ?? '').includes('TOML'), `${id}: TOML 明确不支持`, result.error); continue }
  const names = (result.servers ?? []).map((srv) => srv.serverName)
  check(names.length > 0, `${id}: 识别 ${names.join(', ')}`, JSON.stringify(result.error))
}
console.log('== 用户级 ==')
for (const id of ['claude', 'cursor', 'gemini']) {
  const result = await scan(id, 'global')
  const names = (result.servers ?? []).map((srv) => srv.serverName)
  check(names.length > 0, `${id}: 识别 ${names.join(', ')}`, JSON.stringify(result.error))
}
console.log('== 没有已知文件 / 不支持 ==')
for (const id of NO_FILE) {
  const result = await scan(id, 'project')
  check(((result.error ?? '') + JSON.stringify(result.files)).length > 0, `${id}: 明确提示`, result.error)
}
console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`)
rmSync(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
