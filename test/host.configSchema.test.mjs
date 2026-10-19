/**
 * `Config` 的持久化边界。
 *
 * 现在**只有 `toolFilters`** 是用户配置：技能是磁盘上的 `SKILL.md`，MCP 是 profile
 * patch 里的 Loader 行，列表 / 工具 / 连接状态 / 授权状态都由 `/runtime` 现算。任何
 * 把技能或运行态重新写回 settings 的字段都会让 yml 又长出一条缓存 —— 这个文件钉住
 * 「Config 里只剩 toolFilters」这件事。
 *
 * 这里读源码而不是导入 schema：`src/index.js` import 宿主的
 * `@deepseek-ai/schemastery`，只有运行中的 app 能解析到，CI 上直接 import 会
 * `ERR_MODULE_NOT_FOUND`。冒烟（`scripts/host-smoke.mjs`）能 import 并断言元数据，
 * 但它在 CI 上会跳过，所以这条文本断言是 CI 的护栏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** The `const <name> = z.object({ … })` block for one definition, if present. */
const declarationOf = (name) => {
  const start = source.indexOf(`const ${name} = z.object({`)
  if (start < 0) return undefined
  const end = source.indexOf('\n\n', start)
  return source.slice(start, end < 0 ? undefined : end)
}

const configBlock = (() => {
  const start = source.indexOf('export const Config = z.object({')
  assert.ok(start >= 0, 'src/index.js 里找不到 export const Config')
  const end = source.indexOf('\n})', start)
  assert.ok(end >= 0, '找不到 Config 的收尾')
  return source.slice(start, end + 3)
})()

test('Config 只保留 toolFilters，技能 / 行 / 投影 / 命令字段全部移除', () => {
  assert.match(configBlock, /toolFilters: z\.dict\(/, 'Config 应仍声明 toolFilters')
  assert.match(configBlock, /toolFilters: [\s\S]*?\.volatile\(\)/, 'toolFilters 必须 volatile（settings 只允许写 volatile 字段）')
  for (const removed of [
    'servers:', 'skills:', 'rowOps:', 'rowOpsReady:', 'importRequest:', 'importResult:',
    'skillRequest:', 'skillResult:', 'profileServers:', 'reconnectRequest:', 'reconnectResult:',
    'reconnectReady:', 'workspaces:', 'currentWorkspace:', 'discoveredSkills:', 'skillDirs:',
    'filterState:', 'probeState:', 'oauthState:', 'oauthServers:', 'discoveryInfo:',
  ]) {
    assert.equal(configBlock.includes(removed), false, `Config 里不应再有 ${removed}（它会被写进 yml）`)
  }
})

test('SkillRequest 是纯校验器：不带 .volatile()', () => {
  const wire = declarationOf('SkillRequest')
  assert.ok(wire !== undefined, 'src/index.js 里找不到 const SkillRequest')
  assert.doesNotMatch(wire, /\.volatile\(\)/,
    'SkillRequest 带上 .volatile() 了：它作为 HTTP 路由的校验器会返回 {}，导致 scope/id 丢失')
  assert.equal(source.includes('SkillRequestField'), false, 'Config 字段版本应已删除，只留 HTTP 校验器')
})

test('SkillRequest 声明 path，且字段集合完整', () => {
  const block = declarationOf('SkillRequest')
  assert.ok(block !== undefined, 'src/index.js 里找不到 const SkillRequest')
  assert.match(block, /^\s+path: z\.string\(\)/m, '缺少 path：技能正文读取靠它定位 SKILL.md')
  const names = [...block.matchAll(/^\s{2}([a-zA-Z]+):\s*z\./gm)].map((m) => m[1]).sort()
  assert.deepEqual(names, ['body', 'description', 'id', 'name', 'nonce', 'op', 'path', 'prevName', 'project', 'scope'])
})

test('命令路由的请求 schema 都是纯校验器（没有 .volatile()）', () => {
  for (const name of ['RowOp', 'ReconnectRequest', 'ImportRequest', 'OAuthCommand']) {
    const block = declarationOf(name)
    assert.ok(block !== undefined, `找不到 ${name}`)
    assert.doesNotMatch(block, /\.volatile\(\)/, `${name} 是校验器，不能声明 volatile`)
  }
})
