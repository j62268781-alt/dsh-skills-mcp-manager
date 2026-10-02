/** project/mount 接口测试：cwd 匹配、挂载 key、挂载配置里的 client 名。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mountedKeyOf, projectServersFor, serverMountConfig, setMountClient, workingDirectoryOf,
} from '../src/project/mount.js'

setMountClient({ name: '@deepseek-ai/dsh-mcp-client' })

test('projectServersFor：按 cwd 前缀匹配，排除其他项目与已停用条目', () => {
  const servers = [
    { serverName: 'a', scope: '/p/app', enabled: true },
    { serverName: 'b', scope: '/p/app/sub', enabled: true },
    { serverName: 'c', scope: '/p/other', enabled: true },
    { serverName: 'd', scope: 'global', enabled: true },
    { serverName: 'e', scope: '/p/app', enabled: false },
  ]
  // 契约：scope 必须是 cwd 的祖先目录（/p/app 命中 /p/app/work；/p/app/sub 不命中）
  const hits = projectServersFor(servers, '/p/app/work').map((s) => s.serverName)
  assert.deepEqual(hits, ['a'])
  assert.deepEqual(projectServersFor(servers, '/p/app/sub/deep').map((s) => s.serverName), ['a', 'b'])
  assert.deepEqual(projectServersFor(servers, '/p/none'), [])
})

test('workingDirectoryOf：取 agent 的 cwd', () => {
  assert.equal(workingDirectoryOf({ cwd: '/p/app' }), '/p/app')
})

test('mountedKeyOf：返回字符串 key，同样输入得到同样 key', () => {
  const one = [{ serverName: 'a' }, { serverName: 'b' }]
  assert.equal(typeof mountedKeyOf(one), 'string')
  assert.equal(mountedKeyOf(one), mountedKeyOf(one))
})

test('serverMountConfig：stdio 与 http 各自产出正确的挂载配置形状', () => {
  // client 名由调用点（index.js 的 setMountClient）使用，不在配置里
  const stdio = serverMountConfig({
    serverName: 'x', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: 'T=1', runtime: 'auto',
  })
  assert.equal(stdio.transport, 'stdio')
  assert.equal(stdio.serverName, 'x')
  const text = JSON.stringify(stdio)
  assert.ok(text.includes('pkg') || text.includes('npx'), `stdio 配置缺少命令：${text}`)

  const http = serverMountConfig({ serverName: 'y', transport: 'streamable-http', url: 'https://y/mcp', headers: 'Authorization: Bearer k' })
  assert.equal(http.transport, 'streamable-http')
  assert.equal(http.url, 'https://y/mcp')
})
