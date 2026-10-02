/** components/card 接口测试：详情字段表（含密钥打码）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detailNodes, entryDetailPairs, maskEnv, rowDetailPairs } from '../lib/src/components/card.js'

test('maskEnv：保留键、隐藏值，空值显示占位', () => {
  assert.equal(maskEnv('A=1\nB=two'), 'A=***\nB=***')
  assert.equal(maskEnv(''), '—')
  assert.equal(maskEnv(undefined), '—')
})

test('rowDetailPairs：http 行显示地址、隐藏命令', () => {
  const pairs = rowDetailPairs({
    entryId: 'include:mcp-context7', transport: 'streamable-http', target: 'https://mcp.context7.com/mcp', enabled: true,
  })
  const map = Object.fromEntries(pairs)
  assert.equal(map['行 id'], 'mcp-context7')
  assert.equal(map['地址'], 'https://mcp.context7.com/mcp')
  assert.equal(map['命令'], '—')
  assert.equal(map['状态'], '已启用')
  assert.equal(map['范围'], '全局（配置文件行）')
})

test('rowDetailPairs：stdio 行显示命令、隐藏地址，停用可辨', () => {
  const pairs = new Map(rowDetailPairs({
    entryId: 'mcp-github', transport: 'stdio', target: 'npx', args: '-y pkg', env: 'TOKEN=abc', enabled: false,
  }))
  assert.equal(pairs.get('命令'), 'npx')
  assert.equal(pairs.get('地址'), '—')
  assert.equal(pairs.get('参数'), '-y pkg')
  assert.equal(pairs.get('环境变量'), 'TOKEN=***')
  assert.equal(pairs.get('状态'), '已停用')
})

test('entryDetailPairs：项目条目用数组参数并带上项目名', () => {
  const pairs = new Map(entryDetailPairs({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], enabled: true }, 'tcl_jiguang'))
  assert.equal(pairs.get('命令'), 'npx')
  assert.equal(pairs.get('参数'), '-y pkg')
  assert.equal(pairs.get('范围'), 'tcl_jiguang')
})

test('detailNodes：标签值交替展开', () => {
  const h = (type, props, ...children) => ({ type, props, children })
  const nodes = detailNodes([['a', '1'], ['b', '']], h)
  assert.equal(nodes.length, 4)
  assert.equal(nodes[0].children[0], 'a')
  assert.equal(nodes[1].children[0], '1')
  assert.equal(nodes[3].children[0], '—')
})
