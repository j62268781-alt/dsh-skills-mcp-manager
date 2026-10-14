/**
 * mcp/serverRows 契约测试。
 *
 * 这个模块是改造后的**唯一配置真相源**：两档服务器都来自 profile patch 的 mcp-client 行，
 * 区别只在 `scope`。所以下面的断言围绕三件事：
 *   · 行 → 服务器的投影是否正确（两档一致）
 *   · 作用域匹配是否严格（项目级不能串台）
 *   · 「谁来连」的划分是否清楚（全局交上游、项目交本插件、停用的不连）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GLOBAL_SCOPE, loaderManagedServers, phaseOf, projectServersFor, scopeCovers,
  serverFromRow, serverRows, serverSetKey,
} from '../src/mcp/serverRows.js'

const MCP = '@deepseek-ai/dsh-mcp-client'

const row = (id, config, extra = {}) => ({
  id,
  options: { name: MCP, config },
  ...extra,
})

const httpRow = (id, serverName, scope, extra = {}) => row(id, {
  transport: 'streamable-http', serverName, url: `https://${serverName}.invalid/mcp`,
  ...(scope === undefined ? {} : { scope }),
  ...extra,
})

test('serverFromRow：读原始 options.config，scope 缺省即全局', () => {
  const global = serverFromRow(httpRow('mcp-ctx7', 'ctx7'))
  assert.equal(global.scope, GLOBAL_SCOPE, '没有 scope 字段 = 全局')
  assert.equal(global.loaderManaged, true, '全局由 Loader 连接')
  assert.equal(global.enabled, true)
  assert.equal(global.target, 'https://ctx7.invalid/mcp')

  const project = serverFromRow(httpRow('mcp-git', 'gitnexus', '/Users/me/proj'))
  assert.equal(project.scope, '/Users/me/proj')
  assert.equal(project.loaderManaged, false, '项目级不交给 Loader')
})

test('serverFromRow：stdio 行的 target 合并 command 与 args', () => {
  const stdio = serverFromRow(row('mcp-fs', {
    transport: 'stdio', serverName: 'fs', command: 'npx', args: ['-y', 'server-filesystem', '/tmp'],
  }))
  assert.equal(stdio.transport, 'stdio')
  assert.equal(stdio.target, 'npx -y server-filesystem /tmp')
  assert.equal(stdio.command, 'npx')
  assert.deepEqual(stdio.args, ['-y', 'server-filesystem', '/tmp'])
})

test('disabled 在两档语义不同：全局=用户停用；项目=「Loader 别加载」', () => {
  // 全局行：disabled 就是用户的开关
  const offGlobal = serverFromRow({ ...httpRow('mcp-x', 'x'), disabled: true })
  assert.equal(offGlobal.enabled, false, '全局行 disabled = 用户停用')
  assert.equal(offGlobal.loaderManaged, true, '作用域仍是全局')

  // 项目行：必须 disabled（否则 Loader 会连它，与我们的按 agent 挂载重复），
  // 所以它不能同时充当用户开关——用户开关是 config 里的 enabled
  const projectRow = serverFromRow({ ...httpRow('mcp-p', 'proj', '/p/a'), disabled: true })
  assert.equal(projectRow.enabled, true, '项目行 disabled 只是让 Loader 跳过，仍是「启用」状态')
  assert.equal(projectRow.loaderManaged, false)

  const projectOff = serverFromRow({
    ...httpRow('mcp-p2', 'proj-off', '/p/a', { enabled: false }), disabled: true,
  })
  assert.equal(projectOff.enabled, false, '项目行的用户开关是 config.enabled')
})

test('phaseOf：从 fiber.state 推导（不是读不存在的 fiberPhase）', () => {
  assert.equal(phaseOf({ fiber: { state: 2 } }), 'active')
  assert.equal(phaseOf({ fiber: { state: 1 } }), 'loading')
  assert.equal(phaseOf({ fiber: { state: 0 } }), 'failed')
  assert.equal(phaseOf({}), '')
  assert.equal(phaseOf({ fiberPhase: 'active' }), '', 'raw entry 上没有 fiberPhase 这个字段')
})

test('serverRows：两档一起返回、保持 patch 插入顺序、跳过非 MCP 行与分组行', () => {
  // 顺序 = patch 里的顺序（= 用户创建的顺序），**不按名字排**。
  // 按名字排会让新加的服务器窜到最前（哪个名字靠前就顶到 top 1），
  // 读起来像「它把我的第一台服务器顶掉了」。
  const rows = serverRows([
    httpRow('mcp-z', 'zeta'),
    httpRow('mcp-b', 'beta', '/p/one'),
    httpRow('mcp-a', 'alpha'),
    { id: 'group', options: { name: MCP, group: true, config: {} } },
    { id: 'other', options: { name: 'some-other-plugin', config: {} } },
    httpRow('mcp-noname', ''),
  ])
  assert.deepEqual(rows.map((s) => s.serverName), ['zeta', 'beta', 'alpha'], '按 patch 顺序，不按字母序')
  assert.deepEqual(rows.map((s) => s.scope), [GLOBAL_SCOPE, '/p/one', GLOBAL_SCOPE])
})

test('scopeCovers：按目录前缀匹配，项目之间不串台', () => {
  assert.equal(scopeCovers('/p/app', '/p/app'), true, '项目根本身')
  assert.equal(scopeCovers('/p/app', '/p/app/sub/dir'), true, '子目录')
  assert.equal(scopeCovers('/p/app/', '/p/app/sub'), true, '尾斜杠不影响')
  assert.equal(scopeCovers('/p/app', '/p/application'), false, '同前缀但不同目录，绝不能匹配')
  assert.equal(scopeCovers('/p/app', '/p/other'), false)
  assert.equal(scopeCovers(GLOBAL_SCOPE, '/p/app'), false, '全局不是「项目作用域」')
  assert.equal(scopeCovers('/p/app', ''), false)
})

test('projectServersFor：只返回该 cwd 的项目级、且未停用的', () => {
  const servers = [
    serverFromRow(httpRow('mcp-g', 'global-one')),
    serverFromRow(httpRow('mcp-a', 'proj-a', '/p/a')),
    serverFromRow(httpRow('mcp-b', 'proj-b', '/p/b')),
    serverFromRow({ ...httpRow('mcp-off', 'proj-off', '/p/a', { enabled: false }), disabled: true }),
  ]
  assert.deepEqual(projectServersFor(servers, '/p/a').map((s) => s.serverName), ['proj-a'])
  assert.deepEqual(projectServersFor(servers, '/p/a/deep').map((s) => s.serverName), ['proj-a'])
  assert.deepEqual(projectServersFor(servers, '/p/b').map((s) => s.serverName), ['proj-b'])
  assert.deepEqual(projectServersFor(servers, '/p/c'), [], '不在任何项目里就没有项目级服务器')
  assert.deepEqual(projectServersFor(servers, ''), [])
})

test('loaderManagedServers：全局且启用才交给上游（项目级与停用的都不给）', () => {
  const servers = [
    serverFromRow(httpRow('mcp-g', 'global-one')),
    serverFromRow({ ...httpRow('mcp-off', 'global-off'), disabled: true }),
    serverFromRow(httpRow('mcp-a', 'proj-a', '/p/a')),
  ]
  assert.deepEqual(loaderManagedServers(servers).map((s) => s.serverName), ['global-one'])
})

test('serverSetKey：忽略 phase，但配置变化必须改变它', () => {
  const base = serverFromRow(httpRow('mcp-a', 'alpha'))
  const sameButPhase = { ...base, phase: 'active' }
  const otherPhase = { ...base, phase: 'failed' }
  assert.equal(serverSetKey([base]), serverSetKey([sameButPhase]), 'phase 变化不该触发重挂')
  assert.equal(serverSetKey([base]), serverSetKey([otherPhase]), 'phase 变化不该触发重挂')
  assert.notEqual(serverSetKey([base]), serverSetKey([{ ...base, target: 'https://other/mcp' }]), '换 URL 必须触发')
  assert.notEqual(serverSetKey([base]), serverSetKey([{ ...base, enabled: false }]), '停用必须触发')
  assert.notEqual(serverSetKey([base]), serverSetKey([{ ...base, scope: '/p/a' }]), '换作用域必须触发')
  assert.notEqual(serverSetKey([base]), serverSetKey([]), '删行必须触发')
})

test('端到端：同一条行，两档只差 scope —— 这正是改造要证明的事', () => {
  const globalRow = httpRow('mcp-one', 'shared', undefined)
  const projectRow = httpRow('mcp-two', 'shared', '/p/a')
  const servers = serverRows([globalRow, projectRow])
  assert.equal(servers.length, 2, '同名服务器可以在两档共存')
  assert.deepEqual(loaderManagedServers(servers).map((s) => s.entryId), ['mcp-one'])
  assert.deepEqual(projectServersFor(servers, '/p/a').map((s) => s.entryId), ['mcp-two'])
})

test('serverRows 接受 generator —— loader.entries() 就是 generator', () => {
  // 这个坑真的发生过：`readServers()` 直接把 `loader.entries()` 的结果传进来，
  // 而它是 generator 不是数组 → Array.isArray 为假 → **静默返回空列表**，
  // 于是每个服务器都像「没配置」，而旁边的 projection（先 spread）却看到了全部。
  function* entries() {
    yield httpRow('mcp-a', 'alpha')
    yield httpRow('mcp-b', 'beta', '/p/one')
  }
  const fromGenerator = serverRows(entries())
  assert.deepEqual(fromGenerator.map((s) => s.serverName), ['alpha', 'beta'],
    'generator 输入必须被展开，不能静默变成空')
  assert.deepEqual(fromGenerator, serverRows([...entries()]), 'generator 与数组结果一致')
})

test('新增的服务器排在最后（回归：原先按名字排会窜到 top 1）', () => {
  // 真实反馈：用户加了 chrome-devtools，它出现在列表**第一位**（"c" 排在
  // context7/deepwiki 前面），看起来像把原来的第一台挤掉了。
  // 排序契约是「patch 插入序」，所以后加的必须在末尾。
  const existing = [httpRow('mcp-context7', 'context7'), httpRow('mcp-deepwiki', 'deepwiki')]
  const afterAdd = [...existing, httpRow('mcp-chrome-devtools', 'chrome-devtools')]
  assert.deepEqual(
    serverRows(afterAdd).map((s) => s.serverName),
    ['context7', 'deepwiki', 'chrome-devtools'],
    '新加的在末尾',
  )
  // 名字按字母序完全可能排在前面，所以这条断言必须靠顺序而不是巧合
  assert.ok('chrome-devtools'.localeCompare('context7') < 0, '前提：按字母序它会排最前')
})

test('serverRows 对空/非法输入是空列表，不抛错', () => {  assert.deepEqual(serverRows(undefined), [])
  assert.deepEqual(serverRows(null), [])
  assert.deepEqual(serverRows([]), [])
  assert.deepEqual(serverRows(42), [])
  assert.deepEqual(serverRows('nonsense'), [])
})
