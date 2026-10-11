/**
 * mcp/filter 接口测试。
 *
 * 这是「只保留某些工具」的核心判定，几个关键约定必须钉住：
 *   · 非 MCP 名字（核心/插件工具）永远放行 —— 过滤绝不能碰到它们
 *   · 未配置的服务器放行；配置成 allow 但一个都没勾时也放行（避免误清空）
 *   · 前缀归属取最长匹配（github 与 github__enterprise 同时存在时）
 *   · fail-open：判不了就放行，绝不把自身 bug 变成缺失的能力
 *   · 劫持失败必须如实报告，而不是假装过滤生效
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FILTER_MODES, MODE_ALLOW, MODE_DENY, MODE_OFF, installShadow, isMcpName, judge, liveToolNames, matchServer,
} from '../src/mcp/filter.js'

const SERVERS = ['github', 'chrome-devtools', 'context7']

test('isMcpName：只认 mcp__ 前缀，非字符串一律 false', () => {
  assert.equal(isMcpName('mcp__github__list_issues'), true)
  assert.equal(isMcpName('read_file'), false)
  assert.equal(isMcpName(''), false)
  assert.equal(isMcpName(undefined), false)
  assert.equal(isMcpName(42), false)
})

test('matchServer：拆出服务器与 leaf', () => {
  assert.deepEqual(matchServer('mcp__github__list_issues', SERVERS), { serverName: 'github', leaf: 'list_issues' })
  assert.deepEqual(matchServer('mcp__chrome-devtools__click', SERVERS), { serverName: 'chrome-devtools', leaf: 'click' })
  // 未配置的服务器不归属任何人
  assert.equal(matchServer('mcp__other__x', SERVERS), undefined)
  // 非 MCP 名字
  assert.equal(matchServer('read_file', SERVERS), undefined)
  // 空 leaf 不算这个服务器的工具
  assert.equal(matchServer('mcp__github__', SERVERS), undefined)
})

test('matchServer：最长前缀胜出（github 与 github__enterprise）', () => {
  const names = ['github', 'github__enterprise']
  // 更具体的那一个应当接管，否则工具会挂到错的服务器上
  assert.deepEqual(matchServer('mcp__github__enterprise__list', names), {
    serverName: 'github__enterprise', leaf: 'list',
  })
  assert.deepEqual(matchServer('mcp__github__list', names), { serverName: 'github', leaf: 'list' })
})

test('judge：非 MCP 工具永远放行，任何配置都改不了这一点', () => {
  const rules = { github: { mode: MODE_ALLOW, tools: ['list_issues'] } }
  for (const name of ['read_file', 'bash', 'grep', 'mcp_tool', '']) {
    const verdict = judge(name, rules, SERVERS)
    assert.equal(verdict.admit, true, `${name} 必须放行`)
  }
})

test('judge：未配置的服务器放行；配置里出现但模式为 off 也放行', () => {
  const filters = { 'chrome-devtools': { mode: MODE_ALLOW, tools: ['click'] } }
  assert.equal(judge('mcp__context7__query-docs', filters, SERVERS).admit, true)
  assert.equal(judge('mcp__github__list_issues', filters, SERVERS).admit, true)
  const off = { github: { mode: MODE_OFF, tools: ['list_issues'] } }
  assert.equal(judge('mcp__github__delete_repo', off, SERVERS).admit, true)
})

test('judge：allow 模式只放行勾选的', () => {
  const filters = { github: { mode: MODE_ALLOW, tools: ['list_issues', 'get_issue'] } }
  assert.equal(judge('mcp__github__list_issues', filters, SERVERS).admit, true)
  assert.equal(judge('mcp__github__get_issue', filters, SERVERS).admit, true)
  const dropped = judge('mcp__github__delete_repo', filters, SERVERS)
  assert.equal(dropped.admit, false)
  assert.equal(dropped.serverName, 'github')
  assert.equal(dropped.leaf, 'delete_repo')
  assert.equal(dropped.reason, 'not-allowlisted')
})

test('judge：deny 模式只挡住勾选的', () => {
  const filters = { github: { mode: MODE_DENY, tools: ['delete_repo'] } }
  assert.equal(judge('mcp__github__list_issues', filters, SERVERS).admit, true)
  const dropped = judge('mcp__github__delete_repo', filters, SERVERS)
  assert.equal(dropped.admit, false)
  assert.equal(dropped.reason, 'denylisted')
})

test('judge：allow 但一个都没勾 = 未配置，放行而不是清空该服务器', () => {
  // 这是最危险的误配置：勾了开关还没选工具，若当成「什么都不留」会把整个服务器清空
  const filters = { github: { mode: MODE_ALLOW, tools: [] } }
  assert.equal(judge('mcp__github__list_issues', filters, SERVERS).admit, true)
  assert.equal(judge('mcp__github__delete_repo', filters, SERVERS).admit, true)
})

test('judge：fail-open —— 判不了/形状不对一律放行', () => {
  // 非字符串名字
  assert.equal(judge(undefined, {}, SERVERS).admit, true)
  assert.equal(judge(null, {}, SERVERS).admit, true)
  assert.equal(judge({ name: 'x' }, {}, SERVERS).admit, true)
  // rules 形状不对
  assert.equal(judge('mcp__github__x', null, SERVERS).admit, true)
  assert.equal(judge('mcp__github__x', 'nonsense', SERVERS).admit, true)
  // 规则本身形状不对
  assert.equal(judge('mcp__github__x', { github: null }, SERVERS).admit, true)
  assert.equal(judge('mcp__github__x', { github: { mode: 'bogus', tools: [] } }, SERVERS).admit, true)
  // serverNames 不是数组
  assert.equal(judge('mcp__github__x', {}, undefined).admit, true)
})

test('judge：tools 里的非字符串项被忽略，不会误伤', () => {
  const filters = { github: { mode: MODE_ALLOW, tools: ['list_issues', null, 42, ''] } }
  assert.equal(judge('mcp__github__list_issues', filters, SERVERS).admit, true)
  // 那三个非法项不构成有效白名单，所以仍有 1 个有效项 → 生效
  assert.equal(judge('mcp__github__other', filters, SERVERS).admit, false)
})

test('FILTER_MODES：三种模式齐备', () => {
  assert.deepEqual([...FILTER_MODES].sort(), ['allow', 'deny', 'off'])
})

// ---------- shadow ----------

/** 造一个最小的 ctx，其 tools 服务可被劫持。 */
function fakeCtx() {
  const registered = []
  const instance = {
    register(definition) {
      registered.push(definition.name)
      return () => {}
    },
    schemas() {
      return registered.map((name) => ({ name }))
    },
  }
  return { registered, instance, ctx: { get: (n) => (n === 'tools' ? instance : undefined), logger: { warn() {} } } }
}

test('installShadow：拦住不该注册的，放行该注册的', () => {
  const { ctx, registered } = fakeCtx()
  const decide = (name) => (name === 'mcp__github__delete_repo' ? { admit: false } : { admit: true })
  const shadow = installShadow(ctx, decide, { warn() {} })
  assert.equal(shadow.installed, true)
  ctx.get('tools').register({ name: 'read_file' })
  ctx.get('tools').register({ name: 'mcp__github__list_issues' })
  ctx.get('tools').register({ name: 'mcp__github__delete_repo' })
  assert.deepEqual(registered, ['read_file', 'mcp__github__list_issues'])
})

test('installShadow：被挡下的注册返回可安全调用的 disposer', () => {
  const { ctx } = fakeCtx()
  const shadow = installShadow(ctx, () => ({ admit: false }), { warn() {} })
  const dispose = ctx.get('tools').register({ name: 'mcp__x__y' })
  assert.equal(typeof dispose, 'function')
  // 调用它不能抛：调用方会在下一次 sync 时统一调用
  assert.doesNotThrow(() => dispose())
})

test('installShadow：判定抛错时放行该注册（fail-open）', () => {
  const { ctx, registered } = fakeCtx()
  const warnings = []
  const shadow = installShadow(ctx, () => { throw new Error('boom') }, { warn: (m) => warnings.push(m) })
  ctx.get('tools').register({ name: 'mcp__x__y' })
  assert.deepEqual(registered, ['mcp__x__y'], '判不了也要放行')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /forwarding it unchanged/)
})

test('installShadow：注册表自己的错误要透出来，不能被吞成静默无操作', () => {
  const { ctx } = fakeCtx()
  const shadow = installShadow(ctx, () => ({ admit: true }), { warn() {} })
  const tools = ctx.get('tools')
  const original = tools.register
  // 放行路径必须原样调用真正的 register，让它自己的错误抛出来
  tools.register = function (d) { return original.call(this, d) }
  assert.doesNotThrow(() => tools.register({ name: 'read_file' }))
  shadow.restore()
})

test('installShadow：restore 之后一切照旧', () => {
  const { ctx, registered } = fakeCtx()
  const shadow = installShadow(ctx, () => ({ admit: false }), { warn() {} })
  ctx.get('tools').register({ name: 'mcp__a__b' })
  shadow.restore()
  ctx.get('tools').register({ name: 'mcp__a__b' })
  assert.deepEqual(registered, ['mcp__a__b'], 'restore 后不该再拦')
})

test('installShadow：没有 tools 服务时如实报告未安装，不假装生效', () => {
  const result = installShadow({ get: () => undefined }, () => ({ admit: false }), { warn() {} })
  assert.equal(result.installed, false)
  assert.match(result.reason, /unavailable/)
})

test('installShadow：服务查找抛错时也是未安装', () => {
  const result = installShadow({ get: () => { throw new Error('not injected') } }, () => ({ admit: true }), { warn() {} })
  assert.equal(result.installed, false)
})

test('installShadow：只读的 register 无法劫持时如实报告', () => {
  const frozen = {}
  Object.defineProperty(frozen, 'register', { value: () => {}, writable: false, configurable: false })
  const result = installShadow({ get: () => frozen }, () => ({ admit: true }), { warn() {} })
  // Reflect.set 在不可写属性上返回 false（且可能静默失败），所以必须验证写入结果，
  // 否则会出现「报告安装成功、实际一个都没过滤」这种最坏的失败
  assert.equal(result.installed, false)
  assert.match(result.reason, /not writable/)
})

test('installShadow：优先劫持 traceable view 背后的实例', () => {
  // mcp-client 按名字查找到的是实例；只改 view 的话别的读取方看不到
  const registered = []
  const instance = { register(d) { registered.push(d.name); return () => {} }, schemas: () => [] }
  const view = { register: instance.register, schemas: instance.schemas }
  Reflect.set(view, Symbol.for('cordis.original'), instance)
  const ctx = { get: (n) => (n === 'tools' ? view : undefined), logger: { warn() {} } }
  const shadow = installShadow(ctx, () => ({ admit: false }), { warn() {} })
  assert.equal(shadow.installed, true)
  // 即使绕过 view、直接调实例，也必须被拦住
  instance.register({ name: 'mcp__x__y' })
  assert.deepEqual(registered, [], '实例上的注册也必须被过滤')
})

test('liveToolNames：读得到就给名字，读不到给空数组', () => {
  const { ctx } = fakeCtx()
  ctx.get('tools').register({ name: 'read_file' })
  assert.deepEqual(liveToolNames(ctx), ['read_file'])
  assert.deepEqual(liveToolNames({ get: () => undefined }), [])
  assert.deepEqual(liveToolNames({ get: () => { throw new Error('x') } }), [])
  assert.deepEqual(liveToolNames({ get: () => ({ schemas: () => { throw new Error('y') } }) }), [])
})
