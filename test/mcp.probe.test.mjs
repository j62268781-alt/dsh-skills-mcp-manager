/**
 * mcp/probe 接口测试。
 *
 * 这是「连接状态标签」的唯一事实来源，所以几条约定必须钉死：
 *   · 三种回答要分清 —— 连着 / 未连接 / 没有 provider（后者是挂载问题，不是网络问题）
 *   · 服务器回「方法不支持」这类**别的**错误，恰恰证明请求发出去了 ⇒ 算连着
 *   · **每次探测都重新解析服务**：profile 重新组装会换实例，早先的劫持写法就是因为
 *     把影子留在旧实例上而永远收不到注册（对外还报告「已装上」）
 *   · 项目级服务器必须带上它所在 agent 的 scope，否则服务解析不到它的 provider
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROBE_STATE, createConnectionProbe } from '../src/mcp/probe.js'

/** 造一个假的 mcpResources 服务；`reply` 决定 request 的行为。 */
const serviceWith = (reply) => {
  const calls = []
  return {
    calls,
    service: {
      async request(server, request, exec) {
        calls.push({ server, method: request?.method, agent: exec?.agent })
        return reply(server, request, exec)
      },
    },
  }
}

const ctxWith = (getter) => ({ get: getter })

test('probe：连着 / 未连接 / 没有 provider 三种回答分得清', async () => {
  const { service } = serviceWith((server) => {
    if (server === 'ok') return { resources: [] }
    if (server === 'down') throw new Error('mcp-client(down): server is disconnected')
    throw new Error(`MCP resource server "${server}" is unavailable in this agent's scope`)
  })
  const probe = createConnectionProbe(ctxWith((name) => (name === 'mcpResources' ? service : undefined)))
  assert.equal(probe.available(), true)

  assert.equal((await probe.probe('ok')).state, PROBE_STATE.connected)
  assert.equal((await probe.probe('down')).state, PROBE_STATE.down)
  // 关键区分：没有 provider 是「实例不在」，不是「网络不通」
  assert.equal((await probe.probe('absent')).state, PROBE_STATE.absent)
})

test('probe：服务器回「方法不支持」这类别的错误 ⇒ 算连着', async () => {
  // 客户端未连接时会在发出请求之前就抛 disconnected，所以任何别的回答都证明它活着
  const { service } = serviceWith(() => { throw new Error('Method not found') })
  const probe = createConnectionProbe(ctxWith(() => service))
  assert.equal((await probe.probe('srv')).state, PROBE_STATE.connected)
})

test('probe：每次调用都重新解析服务（profile 重组换实例的回归）', async () => {
  // 真机上打出来的 bug：一次性劫持 register 的影子留在**旧**实例上，profile 重新组装
  // 换实例后，所有注册都从旁边走过去，而监听还报告自己 installed —— 面板因此看不到任何
  // 实例。改成调用服务公开方法后，必须每次都拿当前实例。
  const first = serviceWith(() => ({ resources: [] })).service
  const second = serviceWith(() => { throw new Error('mcp-client(srv): server is disconnected') }).service
  let current = first
  const probe = createConnectionProbe(ctxWith((name) => (name === 'mcpResources' ? current : undefined)))

  assert.equal((await probe.probe('srv')).state, PROBE_STATE.connected)
  current = second // 重新组装：服务实例被换掉
  assert.equal((await probe.probe('srv')).state, PROBE_STATE.down, '换了实例之后必须用新实例')
})

test('probe：服务缺失 / 形状不对时如实说未知，不猜', async () => {
  for (const getter of [
    () => undefined,
    () => { throw new Error('service not injected yet') },
    () => ({ /* 没有 request */ }),
  ]) {
    const probe = createConnectionProbe(ctxWith(getter))
    assert.equal(probe.available(), false)
    assert.match(probe.reason(), /unavailable/)
    assert.equal((await probe.probe('x')).state, PROBE_STATE.unknown)
  }
})

test('probe：项目级服务器把 agent 的 scope 传下去', async () => {
  // provider 注册在 agent 的 scope 里，服务按调用者 scope 解析；不传 agent 就会把
  // 已挂载的项目级服务器报成 absent
  const { service, calls } = serviceWith(() => ({ resources: [] }))
  const probe = createConnectionProbe(ctxWith(() => service))
  const agent = { name: 'agent-under-test' }
  await probe.probe('gitnexus', { agent })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent, agent, 'agent 必须原样传给服务')
  assert.equal(calls[0].method, 'resources/list')
})
