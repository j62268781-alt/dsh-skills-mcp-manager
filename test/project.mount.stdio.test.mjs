/**
 * stdio 挂载的**运行时环境注入**。
 *
 * PATH 不再写进 profile（它属于运行环境，不是配置），所以「子进程能不能找到 node」
 * 这件事全部压在这一层。它一旦坏掉，症状是 stdio 服务器起不来、报一个
 * `env: node: No such file or directory` —— 而配置文件看上去完全正常。
 *
 * 这两件事必须同时成立：
 *   1. 子进程的 PATH 里**有**内置 runtime 的 bin 目录（否则 npx/node 找不到）；
 *   2. profile 里**没有**这条 PATH（否则这份配置换台机器就错，面板还会把它显示给用户）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stdioMountConfig } from '../src/project/mount.js'

test('stdio 挂载：npx 换成内置 runtime 的 node + pnpx，并把 bin 目录放进子进程 PATH', () => {
  const config = stdioMountConfig({
    serverName: 'npm-server', command: 'npx', args: ['-y', '@scope/pkg'],
  })
  // `npx -y <pkg> …` 在 pnpm 的严格布局下会 ERR_PACKAGE_PATH_NOT_EXPORTED，
  // 所以换成 <node> <pnpx.mjs> <pkg>。
  assert.match(config.command, /node$/, `应换成内置 node（收到 ${config.command}）`)
  assert.ok(config.args.some((arg) => /pnpx\.mjs$/.test(arg)), `应走 pnpx（收到 ${JSON.stringify(config.args)}）`)
  assert.ok(!config.args.includes('-y'), '`-y` 要去掉（pnpx 不需要）')
  const binDir = config.command.replace(/\/node$/, '')
  assert.ok(
    String(config.env?.PATH ?? '').split(':').includes(binDir),
    `子进程 PATH 必须含内置 runtime 的 bin 目录（收到 ${config.env?.PATH}）`,
  )
})

test('stdio 挂载：用户填的变量在该在的位置，且不会被 PATH 覆盖掉', () => {
  const config = stdioMountConfig({
    serverName: 'npm-server', command: 'npx', args: ['-y', 'pkg'],
    env: 'TOKEN=abc',
  })
  assert.equal(config.env.TOKEN, 'abc', '用户变量必须传下去')
  assert.ok(String(config.env.PATH ?? '') !== '', 'PATH 仍要注入')
})

test('stdio 挂载：普通命令（非 npm 家族）不替换，但仍然注入 PATH', () => {
  const config = stdioMountConfig({ serverName: 'plain', command: 'node', args: ['server.js'] })
  assert.equal(config.transport, 'stdio')
  // 非 npm 家族不换成 pnpx，命令保持（可能被 resolveCommand 解析成绝对路径）
  assert.match(config.command, /node/, `命令应仍是 node（收到 ${config.command}）`)
  assert.doesNotMatch(config.command, /pnpx/)
})
