import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mcpEntriesFromPatchText, readMcpRowsFromPatch } from '../src/patch/readRows.js'

const PATCH = `- insert:
    - id: mcp-context7
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: context7
        transport: streamable-http
        url: https://mcp.context7.com/mcp
    - id: mcp-gitnexus
      name: "@deepseek-ai/dsh-mcp-client"
      disabled: true
      config:
        serverName: gitnexus
        transport: streamable-http
        url: http://sz-00575123-01/mcp/coding
        scope: /w/proj
        allowInsecureTokenEndpoint: true
`

test('从 patch 文本里取出 mcp-client 行（含 enabled/disabled）', () => {
  /**
   * 列表原来只从 Loader 的注册表读，而 Loader 要 4 秒才重载完一次写入。文件本来是本插件
   * 自己写的，直接读它就能立刻知道「用户刚加的那行在不在」。
   */
  const entries = mcpEntriesFromPatchText(PATCH)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((entry) => entry.id), ['mcp-context7', 'mcp-gitnexus'])
  assert.equal(entries[0].options.config.serverName, 'context7')
  assert.equal(entries[1].disabled, true, '`disabled: true` 必须带出来，否则启停状态会画错')
  assert.equal(entries[1].options.config.allowInsecureTokenEndpoint, true)
  // 形状要够 `serverFromRow` 直接吃
  assert.equal(entries[0].options.name, '@deepseek-ai/dsh-mcp-client')
})

test('跳过带 group 的行：那是分组路由，不是独立服务器', () => {
  // `serverRows` 的过滤条件一致 —— 两处不一致会让同一个文件读出两种行数。
  const text = `- insert:
    - id: mcp-a
      name: "@deepseek-ai/dsh-mcp-client"
      group: some-group
      config:
        serverName: a
`
  assert.deepEqual(mcpEntriesFromPatchText(text), [])
})

test('其它模块的行一律不取', () => {
  const text = `- insert:
    - id: web-server
      name: "@deepseek-ai/dsh-webserver"
      config:
        port: 0
`
  assert.deepEqual(mcpEntriesFromPatchText(text), [])
})

test('!!js 标签不会让解析失败（与 applyRowOp 用同一套 tag）', () => {
  /**
   * patch 里出现 `!!js` 是很常见的（配置里嵌表达式）。如果这里用的自定义 tag 与写入路径
   * 不一致，读回来的文档会直接解析失败 —— 而失败会被静默收敛成「回落到 Loader」，于是
   * 这条优化悄悄失效，没人发现。
   */
  const text = `- insert:
    - id: mcp-a
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: a
        env:
          TOKEN: !!js process.env.TOKEN
`
  const entries = mcpEntriesFromPatchText(text)
  assert.equal(entries.length, 1, '带 !!js 的文档必须还能读')
})

test('坏 YAML 返回 null（调用方回落到 Loader，而不是假装没有服务器）', () => {
  assert.equal(mcpEntriesFromPatchText('- id: [unclosed'), null)
})

test('顶部直接写行（不在 insert 里）也能读到', () => {
  const text = `- id: mcp-top
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: top
`
  assert.deepEqual(mcpEntriesFromPatchText(text).map((entry) => entry.id), ['mcp-top'])
})

test('文件不存在时返回 ok:false，不抛', async () => {
  const result = await readMcpRowsFromPatch('/definitely/not/here/cordis.patch.yml')
  assert.equal(result.ok, false)
  assert.equal(typeof result.reason, 'string')
})
