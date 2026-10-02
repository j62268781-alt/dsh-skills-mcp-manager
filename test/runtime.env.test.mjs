/** runtime/env 接口测试：解析/命令解析/环境注入的形态。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundledRuntime, commandEnv, parseEnv, resolveCommand, spawnEnv, splitArgs } from '../src/runtime/env.js'

test('parseEnv：KEY=VALUE 逐行解析，忽略空行与注释', () => {
  assert.deepEqual(parseEnv('A=1\n\n# c\nB=two=3'), { A: '1', B: 'two=3' })
  assert.deepEqual(parseEnv(''), {})
  assert.deepEqual(parseEnv('NOT_A_PAIR'), {})
})

test('splitArgs：空格分隔，空串得到空数组', () => {
  assert.deepEqual(splitArgs('-y @scope/pkg run x'), ['-y', '@scope/pkg', 'run', 'x'])
  assert.deepEqual(splitArgs('   '), [])
})

test('resolveCommand：含 / 的绝对路径原样返回', () => {
  assert.equal(resolveCommand('/opt/homebrew/bin/npx'), '/opt/homebrew/bin/npx')
})

test('bundledRuntime：存在时给出 node 与 pnpx 路径，不存在返回 null', () => {
  const runtime = bundledRuntime()
  if (runtime === null) return
  assert.match(runtime.node, /node\/bin\/node$/)
  assert.match(runtime.pnpx, /pnpx\.mjs$/)
  assert.equal(runtime.binDir, runtime.node.replace(/\/node$/, ''))
})

test('commandEnv：注入登录 PATH，且不再注入 npm_config_cache', () => {
  const env = commandEnv('npx')
  assert.ok(typeof env.PATH === 'string' && env.PATH.length > 0)
  assert.equal('npm_config_cache' in env, false)
})

test('spawnEnv：合并用户变量，PATH 指向内置 runtime 优先', () => {
  const env = spawnEnv({ TOKEN: 't' })
  assert.equal(env.TOKEN, 't')
  assert.ok(env.PATH.length > 0)
  const runtime = bundledRuntime()
  if (runtime !== null) assert.ok(env.PATH.startsWith(runtime.binDir))
})
