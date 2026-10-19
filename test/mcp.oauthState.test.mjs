/**
 * mcp/oauth/state：`state` 的定长比较与回调参数判定。
 *
 * 这个模块存在的唯一理由是**安全**，所以测试重心放在「该拒绝的必须拒绝」：
 * `/oauth/callback` 挂在 DSH 自己的监听端口上，任何能访问那个端口的东西都能发一个
 * `?code=…&state=…` 进来。误放一个伪造回调（把一个攻击者的 code 换成了用户的令牌）
 * 比漏放严重得多，所以凡是拿不准的都必须返回 false。
 *
 * 另一条被钉住的是**不抛错**：`timingSafeEqual` 在长度不等时抛 `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`，
 * 如果让它冒出去，一次伪造回调会变成一个 500 —— 那看起来像插件坏了，而不是「校验失败」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomToken, singleParams, stateMatches } from '../src/mcp/oauth/state.js'

test('stateMatches：相等才为 true，且大小写/前后空白都算不同', () => {
  const value = 'abcDEF123-_'
  assert.equal(stateMatches(value, value), true)
  assert.equal(stateMatches(value, `${value} `), false)
  assert.equal(stateMatches(value, value.toUpperCase()), false)
  assert.equal(stateMatches('a', 'b'), false)
})

test('stateMatches：长度不等返回 false 而不是抛错', () => {
  // 这正是 `timingSafeEqual` 会抛的那个输入；吞掉它是本模块的核心职责之一。
  assert.doesNotThrow(() => stateMatches('short', 'a-much-longer-state-value'))
  assert.equal(stateMatches('short', 'a-much-longer-state-value'), false)
  assert.equal(stateMatches('', ''), false)
  assert.equal(stateMatches('x', ''), false)
  assert.equal(stateMatches('', 'x'), false)
})

test('stateMatches：非字符串一律 false（不把 undefined 当成空串）', () => {
  for (const [left, right] of [[null, 'x'], ['x', null], [undefined, undefined], [123, '123'], [['a'], ['a']]]) {
    assert.equal(stateMatches(left, right), false, `不该接受 ${String(left)} / ${String(right)}`)
  }
})

test('stateMatches：多字节字符按 UTF-8 字节比较，不按字符数', () => {
  // `String.length` 会把下面的 "é"（1 个码点）+ 一个 ASCII 算成 2，而字节数是 3；
  // 用字符数当长度判据会让 `timingSafeEqual` 抛错。
  const composed = 'éa'
  const plain = 'aa'
  assert.equal(stateMatches(composed, plain), false)
  assert.equal(stateMatches(composed, composed), true)
})

test('randomToken：base64url、长度稳定、两次不重复', () => {
  const first = randomToken()
  const second = randomToken()
  assert.match(first, /^[A-Za-z0-9_-]+$/)
  assert.notEqual(first, second)
  // 32 字节 → 43 个 base64url 字符（无 padding）
  assert.equal(first.length, 43)
  assert.equal(randomToken(16).length, 22)
})

test('singleParams：state 与 code 各一次才合格', () => {
  const ok = singleParams(new URLSearchParams('code=C&state=S'))
  assert.equal(ok.ok, true)
  assert.equal(ok.code, 'C')
  assert.equal(ok.state, 'S')

  // 重复参数是绕过「取第一个」这类实现的经典手法，必须整体拒绝。
  for (const query of [
    'code=C&state=S&state=S2',
    'code=C&code=C2&state=S',
    'code=C',
    'state=S',
    '',
    'code=C&state=S&error=access_denied',
  ]) {
    assert.equal(singleParams(new URLSearchParams(query)).ok, false, `不该合格：${query}`)
  }
})

test('singleParams：把授权服务器的错误原样带出来', () => {
  const denied = singleParams(new URLSearchParams('error=access_denied&error_description=User+denied'))
  assert.equal(denied.ok, false)
  assert.equal(denied.error, 'access_denied')
  // `+` 应被解码成空格，否则面板会把它原样显示给用户。
  assert.equal(denied.errorDescription, 'User denied')
})
