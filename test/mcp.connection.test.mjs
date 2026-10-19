/**
 * mcp/connection 接口测试：连接策略字段（failOnStartupError + reconnect.*）的
 * 解析、边界与回填。边界值取自 dsh-mcp-client 自己的 zod schema。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONNECTION_DEFAULTS, CONNECTION_DRAFT_DEFAULTS, connectionDraftOf, connectionFields } from '../src/mcp/connection.js'

test('connectionFields：没填的 reconnect 写**显式默认值**，不再省略', () => {
  /**
   * 以前留空就省略键、由 MCP 客户端补默认值。问题是表单显示"未设置"而实际有值在生效，
   * 而那个值住在别人的包里 —— 用户要读 `dsh-mcp-client` 的源码才知道这一行到底怎么重连。
   * 现在两端都把它写出来：这是同一件事（500/30000/10），只是不再隐式。
   */
  // toolCallTimeoutMs 是**顶层**键（不在 reconnect 块里），同样写显式默认值
  const defaults = { reconnect: { initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }, toolCallTimeoutMs: 60000 }
  assert.deepEqual(connectionFields({}), defaults)
  assert.deepEqual(connectionFields(undefined), defaults)
  assert.deepEqual(connectionFields({
    failOnStartupError: false,
    reconnectInitialDelayMs: '',
    reconnectMaxDelayMs: '',
    reconnectMaxAttempts: '',
  }), defaults)
})

test('connectionFields：填了的键覆盖默认值，未填的仍是默认', () => {
  assert.deepEqual(
    connectionFields({ reconnectMaxAttempts: '60' }),
    { reconnect: { initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 60 }, toolCallTimeoutMs: 60000 },
  )
  assert.deepEqual(
    connectionFields({ reconnectInitialDelayMs: '1000', reconnectMaxDelayMs: '60000' }),
    { reconnect: { initialDelayMs: 1000, maxDelayMs: 60000, maxAttempts: 10 }, toolCallTimeoutMs: 60000 },
  )
})

test('connectionFields：failOnStartupError 只在 true 时写入', () => {
  // 与 reconnect 不同：false 是客户端的默认值，「键不存在」与「false」完全等价，
  // 所以写它只是给每一行加噪音。
  // toolCallTimeoutMs 是**顶层**键（不在 reconnect 块里），同样写显式默认值
  const defaults = { reconnect: { initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }, toolCallTimeoutMs: 60000 }
  assert.deepEqual(connectionFields({ failOnStartupError: true }), { failOnStartupError: true, ...defaults })
  assert.deepEqual(connectionFields({ failOnStartupError: false }), defaults)
})

test('connectionFields：非整数与越界都拒绝（写进去会让整行加载失败）', () => {
  assert.throws(() => connectionFields({ reconnectMaxAttempts: '3.5' }), /必须是整数/)
  assert.throws(() => connectionFields({ reconnectMaxAttempts: 'abc' }), /必须是整数/)
  assert.throws(() => connectionFields({ reconnectInitialDelayMs: '0' }), /必须在 1–/)
  // 2147483647 是客户端的上限（MAX_TIMER_DELAY_MS），再大一个就拒
  assert.throws(() => connectionFields({ reconnectMaxDelayMs: '2147483648' }), /必须在 1–/)
  assert.deepEqual(connectionFields({ reconnectMaxDelayMs: '2147483647' }), {
    reconnect: { initialDelayMs: 500, maxDelayMs: 2147483647, maxAttempts: 10 },
    toolCallTimeoutMs: 60000,
  })
  // 明文 token 端点例外：**只在 true 时写键**。省略而不是写 `false`，是因为「不写」
  // 就是出厂状态 —— 一份配置里不该留下 `: false` 让人以为曾经开过。
  assert.equal('allowInsecureTokenEndpoint' in connectionFields({}), false)
  assert.equal(connectionFields({ allowInsecureTokenEndpoint: true }).allowInsecureTokenEndpoint, true)
  assert.equal(connectionFields({ allowInsecureTokenEndpoint: 'true' }).allowInsecureTokenEndpoint, undefined, '只认真正的 true，字符串不算')
})

test('connectionDraftOf：回填表单草稿，行里没写的用客户端默认值（不是空串）', () => {
  /**
   * 空串会显示成"未设置"，而实际生效的是 500 —— 表单必须显示真正会用到的值。
   * 与 `connectionFields` 写出去的是同一组数字，所以表单和文件不会各说各话。
   */
  assert.deepEqual(
    connectionDraftOf({ failOnStartupError: true, reconnect: { initialDelayMs: 1000, maxAttempts: 60 } }),
    {
      failOnStartupError: true,
      reconnectInitialDelayMs: '1000',
      reconnectMaxDelayMs: '30000',
      reconnectMaxAttempts: '60',
      // 行里没写 → 回填客户端默认值，而不是空串（空串会显示成"未设置"）
      toolCallTimeoutMs: '60000',
      // 布尔开关：缺失即 false（默认不放宽安全）
      allowInsecureTokenEndpoint: false,
    },
  )
  assert.deepEqual(connectionDraftOf(undefined), {
    failOnStartupError: false,
    reconnectInitialDelayMs: '500',
    reconnectMaxDelayMs: '30000',
    reconnectMaxAttempts: '10',
    toolCallTimeoutMs: '60000',
    allowInsecureTokenEndpoint: false,
  })
  // 行里明确写了 true 才回填 true：这是安全开关，读错方向会打开一个本不该开的例外。
  assert.equal(connectionDraftOf({ allowInsecureTokenEndpoint: true }).allowInsecureTokenEndpoint, true)
  assert.equal(connectionDraftOf({ allowInsecureTokenEndpoint: 'true' }).allowInsecureTokenEndpoint, false, '字符串不算 true')
})

test('表单默认值与写入默认值同源（避免两处各写一遍然后漂移）', () => {
  assert.deepEqual(CONNECTION_DRAFT_DEFAULTS, {
    reconnectInitialDelayMs: String(CONNECTION_DEFAULTS.initialDelayMs),
    reconnectMaxDelayMs: String(CONNECTION_DEFAULTS.maxDelayMs),
    reconnectMaxAttempts: String(CONNECTION_DEFAULTS.maxAttempts),
    toolCallTimeoutMs: String(CONNECTION_DEFAULTS.toolCallTimeoutMs),
    // 布尔开关的默认是 false —— 表单打开时它必须是未勾选的。
    allowInsecureTokenEndpoint: false,
  })
})

test('默认值与客户端文档一致（表单占位用的就是这些）', () => {
  assert.deepEqual(CONNECTION_DEFAULTS, {
    failOnStartupError: false,
    initialDelayMs: 500,
    maxDelayMs: 30000,
    maxAttempts: 10,
    toolCallTimeoutMs: 60000,
  })
})

/**
 * `toolCallTimeoutMs`（PR #1）—— 顶层键，不是 `reconnect` 的成员。
 *
 * 它必须与表单预填同源：`connectionDraftOf` 回填 60000、`connectionFields` 写出 60000，
 * 否则用户会看到输入框显示一个数、而文件里存的是另一个。
 */
test('toolCallTimeoutMs：顶层键的读写与显式默认值', () => {
  // 没填 → 写客户端默认值（与 reconnect 同一规则）
  assert.equal(connectionFields({}).toolCallTimeoutMs, 60000)
  // 填了 → 以填的为准，且不进 reconnect 块
  const tuned = connectionFields({ toolCallTimeoutMs: '600000' })
  assert.equal(tuned.toolCallTimeoutMs, 600000)
  assert.equal('toolCallTimeoutMs' in tuned.reconnect, false, '它不该被塞进 reconnect 块')

  // 回读：有值用值，没值补默认（不是空串）
  assert.equal(connectionDraftOf({ toolCallTimeoutMs: 600000 }).toolCallTimeoutMs, '600000')
  assert.equal(connectionDraftOf({}).toolCallTimeoutMs, '60000')

  // 边界与非法值：写进去会让整行加载失败，所以在这里就要拒
  assert.throws(() => connectionFields({ toolCallTimeoutMs: 'abc' }), /必须是整数/)
  assert.throws(() => connectionFields({ toolCallTimeoutMs: '0' }), /必须在 1–/)
  assert.throws(() => connectionFields({ toolCallTimeoutMs: '2147483648' }), /必须在 1–/)
  assert.equal(connectionFields({ toolCallTimeoutMs: '2147483647' }).toolCallTimeoutMs, 2147483647)
})
