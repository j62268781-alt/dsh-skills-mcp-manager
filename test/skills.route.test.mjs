/**
 * `POST /<name>/skills` —— 技能写入的端点。
 *
 * 与 `mcp.rows.test.mjs` 同一套契约，因为这条路由**会在磁盘上写用户的技能目录**，
 * 所以重点同样是"不被不该用它的人用到"：
 *   · 鉴权在任何解析/写入之前
 *   · 只接受 POST + `application/json`（跨站 HTML 表单发不出这个类型）
 *   · 畸形 JSON 得到 400，而不是让异常逃出去
 *   · 同一 schema 校验，两个通道（HTTP / 设置队列）不能各有一套解释
 *   · 写入**串行**：两次点击不能交错成两次 read-modify-write
 *   · 失败以 `{ ok: false, reason }` 回给面板（HTTP 200，请求本身被正确处理了）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SKILLS_PATH, registerSkillRoute } from '../src/skills/route.js'

/**
 * 等价的本地校验函数，**刻意不 import 宿主的 schemastery**。
 *
 * 那个包是宿主提供的（不在 package.json 依赖里），只有运行中的 app 能解析到 ——
 * `mcp.rows.test.mjs` 早先正是因此在本机过、在 CI 上 `ERR_MODULE_NOT_FOUND`。
 * 这里测的是路由自己的契约，与"谁来做校验"无关。
 */
const makeSchema = ({ requireOp = false } = {}) => (payload) => {
  if (payload === null || typeof payload !== 'object') throw new Error('body must be an object')
  if (requireOp && typeof payload.op !== 'string') throw new Error('op must be a string')
  return { op: '', scope: '', id: '', project: '', name: '', prevName: '', description: '', body: '', nonce: '', ...payload }
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
  registerSkillRoute(ctx, {
    schema: schema ?? makeSchema(),
    apply: apply ?? (async () => ({ ok: true, reason: '', name: '', body: '', nonce: '', at: '' })),
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

test('技能路由：路径带插件前缀，且注册后可释放', () => {
  const h = harness()
  assert.match(SKILLS_PATH, /^\/dsh-skills-mcp-manager\//)
  assert.equal(h.route.path, SKILLS_PATH)
  assert.doesNotThrow(() => h.dispose())
})

test('技能路由：鉴权在任何解析之前', async () => {
  for (const rejection of [401, 403]) {
    let applied = 0
    const h = harness({ rejection, apply: async () => { applied += 1; return { ok: true } } })
    const res = await h.request({ body: JSON.stringify({ op: 'create', name: 'x' }) })
    assert.equal(res.status, rejection)
    assert.equal(applied, 0, '被拒绝的请求不能进入写路径')
  }
})

test('技能路由：只接受 POST，且必须声明 application/json', async () => {
  const h = harness()
  const get = await h.request({ method: 'GET' })
  assert.equal(get.status, 405)
  assert.equal(get.headers.allow, 'POST')

  // 跨站 HTML 表单只能发这三种简单类型，所以要求 application/json 本身就是一道闸门
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const res = await h.request({ type })
    assert.equal(res.status, 415, `${type} 不该被接受`)
  }
})

test('技能路由：畸形 JSON 得到 400，且不写入', async () => {
  let applied = 0
  const h = harness({ apply: async () => { applied += 1; return { ok: true } } })
  const res = await h.request({ body: '{ not json' })
  assert.equal(res.status, 400)
  assert.equal(applied, 0)
  assert.equal(res.json().ok, false)
})

test('技能路由：schema 拒绝的 body 得到 400，且不写入', async () => {
  let applied = 0
  const h = harness({
    schema: makeSchema({ requireOp: true }),
    apply: async () => { applied += 1; return { ok: true } },
  })
  const res = await h.request({ body: JSON.stringify({ op: 42 }) })
  assert.equal(res.status, 400)
  assert.equal(applied, 0)
})

test('技能路由：默认值由 schema 补齐（两个通道不能各有一套解释）', async () => {
  let seen
  const h = harness({ apply: async (request) => { seen = request; return { ok: true, reason: '', name: request.name, body: '', nonce: request.nonce, at: '' } } })
  // 只发 op/name，其余字段应由 schema 补成空串 —— 队列通道也是这个行为
  await h.request({ body: JSON.stringify({ op: 'create', name: 'demo' }) })
  assert.equal(seen.op, 'create')
  assert.equal(seen.name, 'demo')
  for (const key of ['scope', 'id', 'project', 'prevName', 'description', 'body', 'nonce']) {
    assert.equal(seen[key], '', `「${key}」没有被 schema 补成空串`)
  }
})

test('技能路由：成功回执原样返回（含 ok / reason / nonce）', async () => {
  const h = harness({
    apply: async (request) => ({ ok: true, reason: '', name: request.name, body: '', nonce: request.nonce, at: '2026-01-01T00:00:00.000Z' }),
  })
  const res = await h.request({ body: JSON.stringify({ op: 'create', name: 'demo', nonce: 'n1' }) })
  assert.equal(res.status, 200)
  const payload = res.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.nonce, 'n1')
  assert.equal(payload.at, '2026-01-01T00:00:00.000Z')
})

test('技能路由：写入失败是 { ok:false, reason }，HTTP 仍是 200', async () => {
  // 「名字已存在」是用户的输入问题，不是请求本身有问题 —— 面板要拿到 reason 展示
  const h = harness({ apply: async () => ({ ok: false, reason: '「demo」已存在，请换一个名字' }) })
  const res = await h.request({ body: JSON.stringify({ op: 'create', name: 'demo' }) })
  assert.equal(res.status, 200)
  assert.equal(res.json().ok, false)
  assert.match(res.json().reason, /已存在/)
})

test('技能路由：apply 抛异常也回执，不让异常逃出去', async () => {
  const h = harness({ apply: async () => { throw new Error('disk on fire') } })
  const res = await h.request({ body: JSON.stringify({ op: 'create', name: 'demo' }) })
  assert.equal(res.status, 200)
  assert.equal(res.json().ok, false)
  assert.match(res.json().reason, /disk on fire/)
})

test('技能路由：写入串行执行，不交错', async () => {
  const order = []
  const h = harness({
    apply: async (request) => {
      order.push(`start:${request.name}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`end:${request.name}`)
      return { ok: true, reason: '', name: request.name, body: '', nonce: request.nonce, at: '' }
    },
  })
  await Promise.all([
    h.request({ body: JSON.stringify({ op: 'create', name: 'a' }) }),
    h.request({ body: JSON.stringify({ op: 'create', name: 'b' }) }),
  ])
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b'], '两次写入交错了')
})

test('技能路由：一次失败不会卡住后面的写入', async () => {
  const seen = []
  const h = harness({
    apply: async (request) => {
      seen.push(request.name)
      if (request.name === 'bad') throw new Error('nope')
      return { ok: true, reason: '', name: request.name, body: '', nonce: request.nonce, at: '' }
    },
  })
  await h.request({ body: JSON.stringify({ op: 'create', name: 'bad' }) })
  const second = await h.request({ body: JSON.stringify({ op: 'create', name: 'good' }) })
  assert.deepEqual(seen, ['bad', 'good'])
  assert.equal(second.json().ok, true)
})

test('技能路由：响应不可缓存', async () => {
  const h = harness()
  const res = await h.request({ body: JSON.stringify({ op: 'create', name: 'demo' }) })
  assert.equal(res.headers['cache-control'], 'no-store')
})

/**
 * 路由必须把 `scope` / `id` 原样交给写路径 —— 它们是 `writableRoots` 唯一的匹配依据。
 *
 * 丢掉的后果是每次编辑/删除都答「未知的写入区域」，而根因可以很隐蔽：真机上是因为把
 * **volatile 的 Config 字段**直接当成了校验器，而调用一个 volatile schemastery schema
 * 返回 `{}` 而不是校验结果。这条测试用本地校验器钉住路由这一侧的契约
 * （`should not silently drop scope/id`），schema 那一侧由 `host.configSchema.test.mjs`
 * 与冒烟覆盖 —— **这里刻意不 import `@deepseek-ai/schemastery`**，它在 CI 上解析不到，
 * 会让整个测试文件 `ERR_MODULE_NOT_FOUND`（已踩过一次）。
 */
test('技能路由：校验器返回的请求必须保留 scope/id（丢了会报「未知的写入区域」）', async () => {
  let received = null
  const h = harness({
    schema: (payload) => makeSchema()(payload),
    apply: async (request) => { received = request; return { ok: true } },
  })
  await h.request({ body: JSON.stringify({ op: 'delete', scope: 'global', id: 'agents', name: 'x', nonce: 'n1' }) })

  assert.equal(received?.scope, 'global', 'scope 丢了：writableRoots 匹配不到根 ⇒「未知的写入区域」')
  assert.equal(received?.id, 'agents', 'id 丢了：writableRoots 匹配不到根 ⇒「未知的写入区域」')
  assert.equal(received?.name, 'x')
  assert.equal(received?.nonce, 'n1')
})
