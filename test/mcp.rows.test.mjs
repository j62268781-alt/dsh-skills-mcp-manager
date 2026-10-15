/**
 * `POST /<name>/rows` —— 面板命令的写端点。
 *
 * 这是一条**会改用户配置文件**的路由，所以测试的重点不只是"能用"，而是"不被不该用它的人
 * 用到"：
 *   · 鉴权在任何解析/写入之前（和只读的 runtime 路由同一套检查）
 *   · 只接受 POST + `application/json`（跨站 HTML 表单发不出这个类型）
 *   · 未知字段进不了写路径（复用 settings 通道那个 RowOp schema）
 *   · 畸形 JSON / 超长 body 得到 400，而不是让异常逃出去
 *   · 命令**串行**执行：两次点击不能交错成两次 read-modify-write
 *   · 失败以 `{ ok: false, reason }` 回给面板（HTTP 200，因为请求本身被正确处理了）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROWS_PATH, registerRowRoute } from '../src/mcp/rows.js'

/**
 * `registerRowRoute` 只要求一个「能把 payload 校验成 op」的函数，不关心它怎么实现 ——
 * 生产环境传的是宿主的 `RowOp` schema（`@deepseek-ai/schemastery`）。
 *
 * **这里刻意不 import 那个包**：它是宿主提供的（不在 package.json 的依赖里），
 * 只有运行中的 app 能解析到。早先这行 import 让测试在本地过、在 CI 上直接
 * `ERR_MODULE_NOT_FOUND` —— 一个只在 CI 上炸的测试等于没有测试。
 * 用等价的本地校验函数，测的是路由自己的契约（鉴权 / 方法 / content-type /
 * 串行 / 错误回执），与"谁来做校验"无关。
 */
const makeSchema = ({ strict = false } = {}) => (payload) => {
  if (payload === null || typeof payload !== 'object') throw new Error('body must be an object')
  if (strict && payload.op !== 'add' && payload.op !== 'delete') {
    throw new Error(`op expected "add" | "delete" but got "${payload.op}"`)
  }
  return { op: '', entryId: '', enabled: true, ...payload }
}

/** A route harness that drives the handler with a real-ish request/response pair. */
function harness({ apply, rejection, schema } = {}) {
  let route
  const cleanups = []
  const ctx = {
    effect: (fn) => { cleanups.push(fn()) },
    webServer: { register: (value) => { route = value; return () => {} } },
    connection: { requestRejection: () => rejection },
    logger: { warn() {} },
  }
  registerRowRoute(ctx, {
    schema: schema ?? makeSchema(),
    apply: apply ?? (async () => ({ ok: true, reason: '' })),
  })
  return {
    route,
    dispose: () => cleanups.forEach((fn) => fn()),
    request: async ({ method = 'POST', type = 'application/json', body = '{}', headers = {} } = {}) => {
      const sent = {}
      let out = ''
      const res = {
        statusCode: 0,
        setHeader: (k, v) => { sent[k] = v },
        end: (value = '') => { out = value },
      }
      // A minimal readable stream: the handler reads the body in chunks.
      const req = {
        method,
        headers: { 'content-type': type, ...headers },
        on(event, fn) {
          if (event === 'data' && body !== null) fn(Buffer.from(body))
          if (event === 'end') fn()
          return this
        },
        destroy() {},
      }
      await route.handler(req, res)
      return { status: res.statusCode, headers: sent, body: out, json: () => JSON.parse(out) }
    },
  }
}

test('命令路由：路径带插件前缀，且注册后可释放', () => {
  const h = harness()
  assert.match(ROWS_PATH, /^\/dsh-skills-mcp-manager\//)
  assert.equal(h.route.path, ROWS_PATH)
  assert.doesNotThrow(() => h.dispose())
})

test('命令路由：鉴权在任何解析之前', async () => {
  for (const rejection of [401, 403]) {
    let applied = 0
    const h = harness({ rejection, apply: async () => { applied += 1; return { ok: true, reason: '' } } })
    const res = await h.request({ body: JSON.stringify({ op: 'delete', entryId: 'mcp-x' }) })
    assert.equal(res.status, rejection)
    assert.equal(applied, 0, '被拒绝的请求不能进入写路径')
  }
})

test('命令路由：只接受 POST，且必须声明 application/json', async () => {
  const h = harness()
  const wrongMethod = await h.request({ method: 'GET' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')

  // 跨站 HTML 表单只能发这三种简单类型，因此要求 json 就是要求"同源脚本"
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const res = await h.request({ type })
    assert.equal(res.status, 415, `${type} 不该被接受`)
  }
})

test('命令路由：畸形 JSON 与非法字段得到 400，且不执行', async () => {
  let applied = 0
  const h = harness({
    // 用真实的严格 schema：非法值应当抛错
    // 严格版：非法 op 抛错，用来验证「校验失败 → 400 且不执行」
    schema: makeSchema({ strict: true }),
    apply: async () => { applied += 1; return { ok: true, reason: '' } },
  })

  const broken = await h.request({ body: '{not json' })
  assert.equal(broken.status, 400)
  assert.equal(applied, 0)

  const invalid = await h.request({ body: JSON.stringify({ op: 'nope', entryId: 'x' }) })
  assert.equal(invalid.status, 400)
  assert.match(invalid.json().reason, /op/)
  assert.equal(applied, 0, '校验失败的命令不能被执行')
})

test('命令路由：默认值由 schema 补齐（两个通道不能各有一套解释）', async () => {
  const seen = []
  const h = harness({ apply: async (op) => { seen.push(op); return { ok: true, reason: '' } } })
  const res = await h.request({ body: JSON.stringify({ op: 'delete', entryId: 'mcp-x' }) })
  assert.equal(res.status, 200)
  assert.deepEqual(seen, [{ op: 'delete', entryId: 'mcp-x', enabled: true }],
    'schema 声明的默认值必须出现在交给写路径的对象里')
})

test('命令路由：成功返回 { ok: true }，失败返回 { ok: false, reason }', async () => {
  const ok = harness({ apply: async () => ({ ok: true, reason: '' }) })
  assert.deepEqual((await ok.request()).json(), { ok: true, reason: '' })

  // 写失败是**请求被正确处理**，所以仍是 200：面板据此回滚乐观状态并显示原因。
  const bad = harness({ apply: async () => { throw new Error('row "mcp-x" not found in the profile patch') } })
  const res = await bad.request()
  assert.equal(res.status, 200)
  assert.equal(res.json().ok, false)
  assert.match(res.json().reason, /not found/)
})

test('命令路由：命令串行执行，不交错', async () => {
  /**
   * 每个命令都是一次 read-modify-write。两次点击若交错，第二次读到的可能是第一次写之前的
   * 内容，于是先执行的那次改动被静默丢弃。文件锁在写路径里，这条锁的是**顺序**。
   */
  let active = 0
  let maxActive = 0
  const order = []
  const h = harness({
    apply: async (op) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(`start:${op.entryId}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`end:${op.entryId}`)
      active -= 1
      return { ok: true, reason: '' }
    },
  })

  await Promise.all([
    h.request({ body: JSON.stringify({ op: 'delete', entryId: 'a' }) }),
    h.request({ body: JSON.stringify({ op: 'delete', entryId: 'b' }) }),
    h.request({ body: JSON.stringify({ op: 'delete', entryId: 'c' }) }),
  ])

  assert.equal(maxActive, 1, '同一时刻只能有一个命令在写')
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'],
    '命令要按到达顺序完成，而不是交错')
})

test('命令路由：一个失败不会卡住后面的命令', async () => {
  const seen = []
  const h = harness({
    apply: async (op) => {
      seen.push(op.entryId)
      if (op.entryId === 'bad') throw new Error('boom')
      return { ok: true, reason: '' }
    },
  })
  await h.request({ body: JSON.stringify({ op: 'delete', entryId: 'bad' }) })
  const after = await h.request({ body: JSON.stringify({ op: 'delete', entryId: 'good' }) })
  assert.equal(after.json().ok, true)
  assert.deepEqual(seen, ['bad', 'good'], '失败后面的命令仍要执行')
})

test('命令路由：响应不可缓存', async () => {
  const h = harness()
  const res = await h.request()
  assert.equal(res.headers['cache-control'], 'no-store')
})
