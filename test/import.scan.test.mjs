/** import/scan 接口测试：在临时 HOME + 临时项目里造真实文件，逐个来源断言扫描结果。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { IMPORT_SOURCES } from '../src/import/sources.js'
import { scanImportSource } from '../src/import/scan.js'

const home = mkdtempSync(join(tmpdir(), 'smp-import-home-'))
const project = mkdtempSync(join(tmpdir(), 'smp-import-proj-'))
process.env.HOME = home

const write = (base, rel, json) => {
  const file = join(base, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, json === null ? 'x = 1\n' : `${JSON.stringify(json, null, 2)}\n`)
}

/** 每个来源的项目级夹具（用该工具真实的配置形态）。 */
const FIXTURES = {
  claude: ['.mcp.json', { mcpServers: { claudeStdio: { command: 'npx', args: ['-y', 'pkg'] } } }],
  cursor: ['.cursor/mcp.json', { mcpServers: { cursorHttp: { url: 'https://c.example/mcp', headers: { Authorization: 'Bearer k' } } } }],
  gemini: ['.gemini/settings.json', { mcpServers: { geminiOne: { command: 'npx', args: ['-y', 'g'] } } }],
  qwen: ['.qwen/settings.json', { mcpServers: { qwenOne: { command: 'npx', args: ['-y', 'q'] } } }],
  continue: ['.continue/config.json', { mcpServers: { continueOne: { command: 'npx', args: ['-y', 'c'] } } }],
  crush: ['crush.json', { mcp: { crushOne: { command: 'npx', args: ['-y', 'cr'] }, crushHttp: { url: 'https://cr.example/mcp' } } }],
  zed: ['.zed/settings.json', { context_servers: { zedOne: { command: { path: 'node', args: ['z.js'], env: { T: '1' } } }, zedHttp: { url: 'https://z.example/mcp' } } }],
  opencode: ['opencode.json', { mcp: { ocLocal: { type: 'local', command: ['uvx', 'mcp-fetch'], environment: { TOKEN: 't' } }, ocRemote: { type: 'remote', url: 'https://oc.example/mcp' } } }],
  vscode: ['.vscode/mcp.json', { servers: { vsOne: { type: 'stdio', command: 'node', args: ['v.js'] }, vsHttp: { type: 'http', url: 'https://v.example/mcp' } } }],
  antigravity: ['.antigravity/mcp.json', { mcpServers: { agOne: { command: 'npx', args: ['-y', 'ag'] } } }],
  mimocode: ['.mimo/mcp.json', { mcpServers: { mimoOne: { command: 'npx', args: ['-y', 'mi'] } } }],
  kimi: ['.kimi/mcp.json', { mcpServers: { kimiOne: { command: 'npx', args: ['-y', 'ki'] } } }],
  qoder: ['.qoder/mcp.json', { mcpServers: { qoderOne: { command: 'npx', args: ['-y', 'qo'] } } }],
  codex: ['.codex/config.toml', null],
}
for (const [id, [rel, json]] of Object.entries(FIXTURES)) write(project, rel, json)

/** 用户级夹具（只给三个有全局文件的来源）。 */
write(home, '.claude.json', { mcpServers: { claudeG: { command: 'node', args: ['a.js'] } } })
write(home, '.cursor/mcp.json', { mcpServers: { cursorG: { command: 'uvx', args: ['x'] } } })
write(home, '.gemini/settings.json', { mcpServers: { geminiG: { command: 'npx', args: ['-y', 'g2'] } } })

test('项目级：每个有夹具的来源都能识别出条目', () => {
  for (const [id, [, json]] of Object.entries(FIXTURES)) {
    const result = scanImportSource('project', project, id)
    if (id === 'codex') {
      assert.ok((result.error ?? '').length > 0 || result.files.some((f) => f.unsupported > 0), 'codex 应明确不支持')
      continue
    }
    const names = result.servers.map((s) => s.serverName)
    assert.ok(names.length > 0, `${id} 未识别到条目：${JSON.stringify(result.error)}`)
    assert.ok(json !== null)
    for (const server of result.servers) {
      assert.ok(['stdio', 'streamable-http'].includes(server.transport), `${id} 传输异常`)
      // 契约：项目级条目的 scope 就是项目路径（客户端用它做匹配）
      assert.equal(server.scope, project)
    }
  }
})

test('用户级：claude / cursor / gemini 能读到 ~ 下的配置', () => {
  for (const id of ['claude', 'cursor', 'gemini']) {
    const result = scanImportSource('global', project, id)
    assert.ok(result.servers.length > 0, `${id} 用户级未识别：${JSON.stringify(result.error)}`)
    assert.ok(result.servers.every((s) => s.scope === 'global'))
  }
})

test('没有已知文件的来源：给出明确提示而不是静默返回空', () => {
  const noFile = IMPORT_SOURCES.filter((s) => s.project.length === 0).map((s) => s.id)
  assert.ok(noFile.length >= 10, `项目级无文件的来源应有多个，实际 ${noFile.length}`)
  for (const id of noFile) {
    const result = scanImportSource('project', project, id)
    assert.equal(result.servers.length, 0)
    assert.ok((result.error ?? '').length > 0, `${id} 没有给出提示`)
  }
})
