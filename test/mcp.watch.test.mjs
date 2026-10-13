/**
 * mcp/watch 接口测试。
 *
 * 这个模块是「状态标签」的唯一事实来源，所以几条约定必须钉死：
 *   · 原调用必须原样转发（它是监听，不是拦截；弄坏注册会让 MCP 整个不可用）
 *   · 注册错误必须照原样抛出，不能被吞成静默无副作用
 *   · disposer 只能删自己那一笔（同名实例可能已被后来者顶替）
 *   · 探测的判据是「除了 is disconnected，别的回答都算活着」
 *   · 装不上时如实报告，而不是假装在监听
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installConnectionWatch } from '../src/mcp/watch.js'

/** 造一个假的 mcpResources 服务，记录所有调用。 */
const fakeService = (overrides = {}) => {
  const calls = []
  const service = {
    register(server, provider) {
      calls.push({ server, provider })
      return () => { calls.push({ disposed: server }) }
    },
    ...overrides,
  }
  return { service, calls }
}

const ctxWith = (service) => ({
  get: (name) => {
    if (name !== 'mcpResources') return undefined
    if (service === null) throw new Error('service not injected yet')
    return service
  },
})

test('installConnectionWatch：装上后能看见实例，且原调用原样转发', () => {
  const { service, calls } = fakeService()
  const watch = installConnectionWatch(ctxWith(service))
  assert.equal(watch.installed, true)
  const provider = { request: async () => ({}) }
  const dispose = service.register('gitnexus', provider)
  assert.equal(calls.length, 1, '原调用没被转发')
  assert.equal(calls[0].server, 'gitnexus')
  assert.equal(watch.has('gitnexus'), true)
  assert.deepEqual(watch.instances(), ['gitnexus'])
  // 返回值仍然是可用的 disposer
  dispose()
  assert.equal(watch.has('gitnexus'), false)
  watch.restore()
})

test('installConnectionWatch：disposer 只删自己那一笔', () => {
  const { service } = fakeService()
  const watch = installConnectionWatch(ctxWith(service))
  const first = { request: async () => ({}) }
  const second = { request: async () => ({}) }
  const disposeFirst = service.register('deepwiki', first)
  service.register('deepwiki', second)
  // 旧实例的 disposer 晚到：不能把新实例的记录删掉
  disposeFirst()
  assert.equal(watch.has('deepwiki'), true, '旧 disposer 误删了新实例')
  watch.restore()
})

test('installConnectionWatch：注册错误照原样抛出，不吞', () => {
  const boom = new Error('already registered')
  const { service } = fakeService({ register() { throw boom } })
  const watch = installConnectionWatch(ctxWith(service))
  assert.throws(() => service.register('dup', {}), /already registered/)
  watch.restore()
})

test('probe：连着 / 未连接 / 服务器拒绝请求（也算连着）', async () => {
  const { service } = fakeService()
  const watch = installConnectionWatch(ctxWith(service))
  let mode = 'ok'
  service.register('srv', {
    request: async () => {
      if (mode === 'ok') return { resources: [] }
      if (mode === 'down') throw new Error('mcp-client(srv): server is disconnected')
      throw new Error('Method not found')
    },
  })
  assert.equal((await watch.probe('srv')).state, 'connected')
  mode = 'down'
  assert.equal((await watch.probe('srv')).state, 'down')
  // 关键判据：客户端未连接时会在发请求前就抛 disconnected，
  // 所以「服务器回了别的错」恰恰证明客户端是活的
  mode = 'unsupported'
  assert.equal((await watch.probe('srv')).state, 'connected')
  // 没有实例时不猜
  assert.equal((await watch.probe('nope')).state, 'absent')
  watch.restore()
})

test('installConnectionWatch：服务缺失 / register 不可写时如实报告', async () => {
  const missing = installConnectionWatch(ctxWith(null))
  assert.equal(missing.installed, false)
  assert.match(missing.reason, /unavailable/)
  // 没装上时一律「未知」，绝不猜成「已连接」
  assert.equal(await missing.probe('x').then((r) => r.state), 'unknown')
  assert.equal(missing.has('x'), false)

  const frozen = Object.freeze({ register() {} })
  const locked = installConnectionWatch(ctxWith(frozen))
  assert.equal(locked.installed, false)

  const noRegister = installConnectionWatch(ctxWith({}))
  assert.equal(noRegister.installed, false)
})

test('restore：还原成原方法，之后不再记录', () => {
  const { service } = fakeService()
  const original = service.register
  const watch = installConnectionWatch(ctxWith(service))
  assert.notEqual(service.register, original)
  watch.restore()
  assert.equal(service.register, original)
  service.register('after', { request: async () => ({}) })
  assert.equal(watch.has('after'), false, 'restore 之后仍在监听')
})
