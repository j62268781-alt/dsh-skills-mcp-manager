/** project/mount 接口测试：cwd 匹配、挂载 key、挂载配置里的 client 名。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  envObject, mountedKeyOf, projectServersFor, serverMountConfig, setMountClient, workingDirectoryOf,
} from '../src/project/mount.js'
import { serverFromRow } from '../src/mcp/serverRows.js'

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

test('serverMountConfig：连接策略跟着挂载配置走，留空则不写', () => {
  const base = { serverName: 'z', transport: 'streamable-http', url: 'https://z/mcp' }
  const plain = serverMountConfig(base)
  // failOnStartupError=false 与"键不存在"等价，所以不写；reconnect 现在写显式默认值，
  // 让挂载出来的客户端重连策略与配置行一致，而不是依赖客户端的隐式默认。
  assert.equal('failOnStartupError' in plain, false)
  assert.deepEqual(plain.reconnect, { initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 })

  const tuned = serverMountConfig({
    ...base,
    failOnStartupError: true,
    reconnectInitialDelayMs: '1000',
    reconnectMaxDelayMs: '60000',
    reconnectMaxAttempts: '60',
  })
  assert.equal(tuned.failOnStartupError, true)
  assert.deepEqual(tuned.reconnect, { initialDelayMs: 1000, maxDelayMs: 60000, maxAttempts: 60 })
})

test('serverMountConfig：数字非法时退回客户端默认，不让挂载整体失败', () => {
  const mounted = serverMountConfig({
    serverName: 'z', transport: 'streamable-http', url: 'https://z/mcp', reconnectMaxAttempts: '0',
  })
  assert.equal(mounted.url, 'https://z/mcp')
  assert.equal('reconnect' in mounted, false)
})

/**
 * issue #2 的回归：项目级 stdio 行的 env 没有传给子进程。
 *
 * 根因是**形状**而不是宿主：`serverRows()` 产出的 `env`/`headers` 已经是解析好的**对象**，
 * 而 `mount.js` 对它调 `parseEnv()`（期望 `KEY=VALUE` 文本行）。`String({...})` 得到
 * `"[object Object]"`，没有 `=`，于是每一行都被跳过，返回 `{}` —— 环境变量静默消失，
 * 没有任何报错，而同一份配置在 0.5.4 的 `config.servers[]` 路径（传字符串）下是好的。
 *
 * 这条测试刻意用**真实的** `serverFromRow()` 形状，而不是手写字符串：现有测试全都传字符串，
 * 正是这个 bug 能溜过去的原因。
 */
test('serverMountConfig：对象形状的 env 也要带到子进程（issue #2 回归）', () => {
  const server = serverFromRow({
    id: 'mcp-rea',
    // 项目行必须以 disabled: true 写入，否则 Loader 会把它也连一次
    disabled: true,
    options: {
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'rea', transport: 'stdio', command: 'rea', args: ['--mcp'],
        env: { JAVA_HOME: '/opt/jdk', GHIDRA_INSTALL_DIR: '/opt/ghidra' },
        scope: '/p/proj',
      },
    },
  })
  // 前提：投影出来的确实是对象（不是字符串），否则这条测试就没在测真正的问题
  assert.equal(typeof server.env, 'object', 'serverRows 应当给出对象形状的 env')

  const mount = serverMountConfig(server)
  assert.equal(mount.env.JAVA_HOME, '/opt/jdk', 'env 丢失了（对象形状没被识别）')
  assert.equal(mount.env.GHIDRA_INSTALL_DIR, '/opt/ghidra')
})

test('serverMountConfig：对象形状的 headers 也要带过去（Authorization 不能静默丢失）', () => {
  const mount = serverMountConfig({
    serverName: 'z', transport: 'streamable-http', url: 'https://z/mcp',
    headers: { Authorization: 'Bearer k' },
  })
  assert.equal(mount.headers.Authorization, 'Bearer k')
})

test('envObject：两种形状都接受，空值与非对象不炸', () => {
  // 对象（serverRows 的形状）
  assert.deepEqual(envObject({ A: '1', B: 2 }), { A: '1', B: '2' })
  // 文本行（面板草稿 / 导入的形状）
  assert.deepEqual(envObject('A=1\nB=2'), { A: '1', B: '2' })
  // 空值
  assert.deepEqual(envObject(undefined), {})
  assert.deepEqual(envObject(null), {})
  assert.deepEqual(envObject(''), {})
  // 不该被当成对象处理的东西
  assert.deepEqual(envObject(['A=1']), {})
  assert.deepEqual(envObject(42), {})
  // 空键与空值跳过，而不是写进一个空名字的变量
  assert.deepEqual(envObject({ '': 'x', OK: null, KEEP: 'v' }), { KEEP: 'v' })
})
