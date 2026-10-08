/**
 * mcp/connection 接口测试：连接策略字段（failOnStartupError + reconnect.*）的
 * 解析、边界与回填。边界值取自 dsh-mcp-client 自己的 zod schema。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONNECTION_DEFAULTS, connectionDraftOf, connectionFields } from '../src/mcp/connection.js'

test('connectionFields：全空时不写任何键（留给客户端的默认值）', () => {
  assert.deepEqual(connectionFields({}), {})
  assert.deepEqual(connectionFields(undefined), {})
  assert.deepEqual(connectionFields({
    failOnStartupError: false,
    reconnectInitialDelayMs: '',
    reconnectMaxDelayMs: '',
    reconnectMaxAttempts: '',
  }), {})
})

test('connectionFields：只写填了的键，reconnect 只含填了的数字', () => {
  assert.deepEqual(connectionFields({ reconnectMaxAttempts: '60' }), { reconnect: { maxAttempts: 60 } })
  assert.deepEqual(
    connectionFields({ reconnectInitialDelayMs: '1000', reconnectMaxDelayMs: '60000' }),
    { reconnect: { initialDelayMs: 1000, maxDelayMs: 60000 } },
  )
})

test('connectionFields：failOnStartupError 只在 true 时写入', () => {
  assert.deepEqual(connectionFields({ failOnStartupError: true }), { failOnStartupError: true })
  assert.deepEqual(connectionFields({ failOnStartupError: false }), {})
})

test('connectionFields：非整数与越界都拒绝（写进去会让整行加载失败）', () => {
  assert.throws(() => connectionFields({ reconnectMaxAttempts: '3.5' }), /必须是整数/)
  assert.throws(() => connectionFields({ reconnectMaxAttempts: 'abc' }), /必须是整数/)
  assert.throws(() => connectionFields({ reconnectInitialDelayMs: '0' }), /必须在 1–/)
  // 2147483647 是客户端的上限（MAX_TIMER_DELAY_MS），再大一个就拒
  assert.throws(() => connectionFields({ reconnectMaxDelayMs: '2147483648' }), /必须在 1–/)
  assert.deepEqual(connectionFields({ reconnectMaxDelayMs: '2147483647' }), { reconnect: { maxDelayMs: 2147483647 } })
})

test('connectionDraftOf：把行配置回填成表单草稿，缺省是空串', () => {
  assert.deepEqual(
    connectionDraftOf({ failOnStartupError: true, reconnect: { initialDelayMs: 1000, maxAttempts: 60 } }),
    {
      failOnStartupError: true,
      reconnectInitialDelayMs: '1000',
      reconnectMaxDelayMs: '',
      reconnectMaxAttempts: '60',
    },
  )
  const empty = connectionDraftOf(undefined)
  assert.deepEqual(empty, {
    failOnStartupError: false,
    reconnectInitialDelayMs: '',
    reconnectMaxDelayMs: '',
    reconnectMaxAttempts: '',
  })
})

test('默认值与客户端文档一致（表单占位用的就是这些）', () => {
  assert.deepEqual(CONNECTION_DEFAULTS, {
    failOnStartupError: false,
    initialDelayMs: 500,
    maxDelayMs: 30000,
    maxAttempts: 10,
  })
})
