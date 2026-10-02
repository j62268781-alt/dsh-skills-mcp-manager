/** import/sources 接口测试：来源表、形态适配、宽松 JSON、路径解析。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { IMPORT_SOURCES, adaptImportedEntry, importFilePath, parseJsonLoose } from '../src/import/sources.js'

test('来源表：26 项、id 唯一、字段齐备', () => {
  assert.equal(IMPORT_SOURCES.length, 26)
  const ids = IMPORT_SOURCES.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const source of IMPORT_SOURCES) {
    assert.equal(typeof source.label, 'string')
    assert.ok(Array.isArray(source.project) && Array.isArray(source.global))
  }
  // 截图里要求的 25 个来源都在
  for (const id of ['claude', 'codex', 'chatgpt', 'cursor', 'gemini', 'antigravity', 'reasonix', 'opencode',
    'mimocode', 'teleagent', 'kilo', 'zcode', 'grok', 'openclaw', 'pi', 'hermes', 'kimi', 'qoder',
    'workbuddy', 'qwen', 'continue', 'cline', 'goose', 'zed', 'crush']) {
    assert.ok(ids.includes(id), `缺少来源 ${id}`)
  }
})

test('adaptImportedEntry：mcpServers（stdio 与 http）', () => {
  const stdio = adaptImportedEntry('a', { command: 'npx', args: ['-y', 'pkg'], env: { T: '1' } }, undefined)
  assert.equal(stdio.transport, 'stdio')
  assert.equal(stdio.command, 'npx')
  assert.deepEqual(stdio.args, ['-y', 'pkg'])
  assert.equal(stdio.env, 'T=1')
  const http = adaptImportedEntry('b', { url: 'https://x/mcp', headers: { Authorization: 'Bearer k' } }, undefined)
  assert.equal(http.transport, 'streamable-http')
  assert.equal(http.url, 'https://x/mcp')
  assert.match(http.headers, /Authorization/)
  assert.equal(adaptImportedEntry('c', { nothing: true }, undefined), null)
})

test('adaptImportedEntry：zed 的 context_servers（command.path）与 opencode 的 mcp（type/command[]）', () => {
  const zed = adaptImportedEntry('z', { command: { path: 'node', args: ['z.js'] } }, 'zed')
  assert.equal(zed.command, 'node')
  assert.deepEqual(zed.args, ['z.js'])
  const zedHttp = adaptImportedEntry('zh', { url: 'https://z/mcp' }, 'zed')
  assert.equal(zedHttp.transport, 'streamable-http')

  const local = adaptImportedEntry('o', { type: 'local', command: ['uvx', 'fetch'], environment: { K: 'v' } }, 'opencode')
  assert.equal(local.command, 'uvx')
  assert.deepEqual(local.args, ['fetch'])
  assert.equal(local.env, 'K=v')
  const remote = adaptImportedEntry('or', { type: 'remote', url: 'https://o/mcp' }, 'opencode')
  assert.equal(remote.transport, 'streamable-http')
})

test('parseJsonLoose：容忍注释与尾逗号', () => {
  const parsed = parseJsonLoose(`{
    // 行注释
    "mcpServers": { "a": { "command": "npx" }, /* 块注释 */ },
  }`)
  assert.deepEqual(parsed.mcpServers.a.command, 'npx')
})

test('importFilePath：~/ 走用户目录，相对路径走项目目录', () => {
  assert.equal(importFilePath('~/.claude.json', '/proj'), join(homedir(), '.claude.json'))
  assert.equal(importFilePath('.mcp.json', '/proj'), join('/proj', '.mcp.json'))
})
