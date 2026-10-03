/** 未定义名字检查器的过滤逻辑（含历史 bug 的真实 tsc 输出）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ENVIRONMENT_NAMES, undefinedNames } from '../scripts/undefined-check.mjs'

test('真实历史输出：invalidate 会被拦下（这正是导致整个 profile 被隔离的那个 bug）', () => {
  const output = `src/index.js(585,13): error TS2304: Cannot find name 'invalidate'.`
  const found = undefinedNames(output)
  assert.equal(found.length, 1)
  assert.equal(found[0].name, 'invalidate')
})

test('纯环境名被放行（没有环境类型定义时的假警报）', () => {
  const output = [
    "src/a.js(1,1): error TS2304: Cannot find name 'setInterval'.",
    "src/a.js(2,1): error TS2304: Cannot find name 'process'.",
    "src/a.js(3,1): error TS2304: Cannot find name 'console'.",
  ].join('\n')
  assert.deepEqual(undefinedNames(output), [])
  assert.equal(ENVIRONMENT_NAMES.has('setInterval'), true)
})

test('拼错的名字（TS2552）同样被拦下', () => {
  const found = undefinedNames("src/b.js(9,3): error TS2552: Cannot find name 'hander'. Did you mean 'handler'?")
  assert.equal(found.length, 1)
  assert.equal(found[0].name, 'hander')
})

test('其它类型的错误不参与判定（交给各自的闸门）', () => {
  const output = [
    "src/c.js(1,1): error TS2307: Cannot find module 'node:fs/promises' or its corresponding type declarations.",
    'src/d.js(2,2): error TS2322: Type number is not assignable to type string.',
  ].join('\n')
  assert.deepEqual(undefinedNames(output), [])
})
