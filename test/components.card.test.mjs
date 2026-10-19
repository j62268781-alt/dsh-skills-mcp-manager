/** components/card 接口测试：详情字段表（含密钥打码、按传输省略无关字段）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { detailNodes, entryDetailPairs, hasInjectedPath, headersText, maskEnv, maskHeaders, rowDetailPairs, splitEnv } from '../lib/src/components/card.jsx'

globalThis.__dshReact = React

test('splitEnv：把自动注入的 PATH 与用户自填变量分开', () => {
  // 真实形态：全局 stdio 行会被注入一条超长 PATH（那是机器的登录 PATH）
  const injected = 'TOKEN=abc\nPATH=C:\\WINDOWS\\system32;C:\\WINDOWS;D:\\nodejs\\'
  const { own, path } = splitEnv(injected)
  assert.equal(own, 'TOKEN=abc', '用户变量要单独拿出来')
  assert.match(path, /^C:\\WINDOWS/, 'PATH 归到 path')

  // 大小写不敏感：配置里也可能写成 Path
  assert.equal(splitEnv('Path=/usr/bin:/bin').path, '/usr/bin:/bin')

  // 没有 PATH 时 path 为空，用户变量原样保留
  const plain = splitEnv('A=1\nB=2')
  assert.equal(plain.path, '')
  assert.equal(plain.own, 'A=1\nB=2')

  // 空输入
  assert.deepEqual(splitEnv(''), { own: '', path: '' })
  assert.deepEqual(splitEnv(undefined), { own: '', path: '' })
})

test('hasInjectedPath：判断是否为 stdio 行自动注入了 PATH', () => {
  assert.equal(hasInjectedPath('PATH=C:\\a;C:\\b'), true)
  assert.equal(hasInjectedPath('TOKEN=abc'), false)
  assert.equal(hasInjectedPath(''), false)
  assert.equal(hasInjectedPath(undefined), false)
})

test('rowDetailPairs：stdio 行有注入 PATH 时单独标注，不混进用户变量', () => {
  const map = Object.fromEntries(rowDetailPairs({
    entryId: 'mcp-chrome-devtools', transport: 'stdio', target: 'npx -y chrome-devtools-mcp@latest',
    args: '-y chrome-devtools-mcp@latest', env: 'PATH=C:\\WINDOWS;D:\\nodejs\\', enabled: true,
  }))
  // 关键：不能把那一长串 PATH 当成「环境变量」显示
  assert.equal(map['环境变量'], undefined, '用户没配变量时不该出现「环境变量」行')
  assert.match(map['PATH'], /自动注入/)
  // 标签必须短：详情区标签列只有 76px，长的会折行并破坏对齐
  assert.ok(map['PATH'] !== undefined, '键名保持为 PATH')
  assert.ok(!('PATH（自动注入）' in map), '标签不能带括号后缀，否则折行')
  assert.doesNotMatch(JSON.stringify(map), /D:\\\\nodejs/, '不该把整串 PATH 摊开')
})

test('rowDetailPairs：用户自填变量与注入 PATH 同时存在时两者都在', () => {
  const map = Object.fromEntries(rowDetailPairs({
    entryId: 'mcp-x', transport: 'stdio', target: 'npx', args: '-y p',
    env: 'TOKEN=secret\nPATH=C:\\a;C:\\b', enabled: true,
  }))
  assert.equal(map['环境变量'], 'TOKEN=***', '用户变量打码后显示')
  assert.match(map['PATH'], /自动注入/)
})

test('maskEnv：保留键、隐藏值，空值显示占位', () => {
  assert.equal(maskEnv('A=1\nB=two'), 'A=***\nB=***')
  assert.equal(maskEnv(''), '—')
  assert.equal(maskEnv(undefined), '—')
})

test('maskHeaders：请求头打码，不能漏出 Bearer', () => {
  // 请求头是 KEY: VALUE / KEY=VALUE，用 env 的掩码（只切 =）会原样泄露令牌
  assert.equal(maskHeaders('Authorization: Bearer sk-abc'), 'Authorization:***')
  assert.equal(maskHeaders('Authorization=Bearer sk-abc'), 'Authorization=***')
  assert.equal(maskHeaders({ Authorization: 'Bearer sk-abc' }), 'Authorization:***')
  assert.equal(maskHeaders(''), '—')
  assert.equal(maskHeaders(undefined), '—')
})

test('headersText：对象与文本都渲染成行', () => {
  assert.equal(headersText({ A: '1', B: '2' }), 'A: 1\nB: 2')
  assert.equal(headersText('A: 1'), 'A: 1')
  assert.equal(headersText(undefined), '')
})

test('rowDetailPairs：http 行只给地址，不出现命令/参数/环境变量', () => {
  const pairs = rowDetailPairs({
    entryId: 'include:mcp-context7', transport: 'streamable-http', target: 'https://mcp.context7.com/mcp', enabled: true,
  })
  const map = Object.fromEntries(pairs)
  assert.equal(map['行 id'], 'mcp-context7')
  assert.equal(map['地址'], 'https://mcp.context7.com/mcp')
  // 没有「状态」行：右侧开关就是启停状态的唯一真源，再用文字写一遍会让两处漂移
  // （开关是乐观更新的，文字来自投影）。
  assert.ok(!('状态' in map), '启停已由开关表达，不该再有「状态」行')
  // 「作用域」带真实值：两档统一成一个列表之后，卡片必须说清这台服务器对谁可用。
  // 键已经是「作用域」，值里不再重复「工作区」——否则这一列读成「作用域 | 工作区：…」。
  assert.equal(map['作用域'], '全局')
  // 无关字段整条省略，而不是显示占位符
  assert.ok(!('命令' in map), 'http 行不该出现「命令」')
  assert.ok(!('参数' in map), 'http 行不该出现「参数」')
  assert.ok(!('环境变量' in map), 'http 行不该出现「环境变量」')
})

test('rowDetailPairs：作用域只给路径，不重复「工作区」三个字', () => {
  /**
   * 键已经写了「作用域」，值再带「工作区：」前缀等于把同一件事说两遍，而且把真正要看
   * 的路径推向右边。全局档同理只写「全局」。
   */
  const project = Object.fromEntries(rowDetailPairs({
    entryId: 'mcp-gitnexus', transport: 'streamable-http', target: 'http://x/mcp', scope: '/p/tcl', enabled: true,
  }))
  assert.equal(project['作用域'], '/p/tcl')
  assert.equal(project['作用域'].includes('工作区'), false, '值里不该再出现「工作区」')
  const global = Object.fromEntries(rowDetailPairs({
    entryId: 'mcp-x', transport: 'streamable-http', target: 'http://y/mcp',
  }))
  assert.equal(global['作用域'], '全局')
})

test('rowDetailPairs：http 行有请求头才显示，且已打码', () => {
  const map = Object.fromEntries(rowDetailPairs({
    entryId: 'mcp-x', transport: 'streamable-http', target: 'https://x/mcp', headersText: 'Authorization=Bearer sk-abc',
  }))
  assert.equal(map['请求头'], 'Authorization=***')
  const bare = Object.fromEntries(rowDetailPairs({
    entryId: 'mcp-y', transport: 'streamable-http', target: 'https://y/mcp',
  }))
  assert.ok(!('请求头' in bare), '没有请求头就不显示这一行')
})
test('rowDetailPairs：stdio 行只给命令，不出现地址', () => {
  const map = Object.fromEntries(rowDetailPairs({
    entryId: 'mcp-github', transport: 'stdio', target: 'npx', args: '-y pkg', env: 'TOKEN=abc', enabled: false,
  }))
  assert.equal(map['命令'], 'npx')
  assert.equal(map['参数'], '-y pkg')
  assert.equal(map['环境变量'], 'TOKEN=***')
  // 停用状态不再出现在详情里：开关（在卡片右侧）才是它的唯一真源。
  assert.ok(!('状态' in map), '停用状态由开关表达，不该再有「状态」行')
  assert.ok(!('地址' in map), 'stdio 行不该出现「地址」')
  assert.ok(!('请求头' in map), 'stdio 行不该出现「请求头」')
})

test('entryDetailPairs：项目条目用数组参数并带上项目名', () => {
  const map = Object.fromEntries(entryDetailPairs({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], enabled: true }, 'tcl_jiguang'))
  assert.equal(map['命令'], 'npx')
  assert.equal(map['参数'], '-y pkg')
  assert.equal(map['范围'], 'tcl_jiguang')
})

test('entryDetailPairs：http 条目不显示命令，请求头打码', () => {
  const map = Object.fromEntries(entryDetailPairs({
    transport: 'streamable-http', url: 'https://x/mcp', headers: { Authorization: 'Bearer sk-abc' },
  }))
  assert.equal(map['地址'], 'https://x/mcp')
  assert.equal(map['请求头'], 'Authorization:***')
  assert.ok(!('命令' in map))
})

test('detailNodes：标签值交替展开，空值显示占位', () => {
  const nodes = detailNodes([['a', '1'], ['b', '']])
  assert.equal(nodes.length, 4)
  assert.equal(nodes[0].type, 'span')
  assert.equal(nodes[0].props.className, 'smp-detailsKey')
  assert.equal(nodes[0].props.children, 'a')
  assert.equal(nodes[1].props.className, 'smp-detailsValue')
  assert.equal(nodes[1].props.children, '1')
  assert.equal(nodes[3].props.children, '—')
})
