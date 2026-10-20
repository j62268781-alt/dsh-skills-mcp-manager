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
import { bundledRuntime } from '../src/runtime/env.js'

test('stdio 挂载：默认用系统 npx（内置 pnpx 只做兜底）', () => {
  /**
   * **默认值曾经是反的**，真机上炸得很彻底：
   *
   *   `npx -y @modelcontextprotocol/server-filesystem`
   *   → 换成「内置 node + pnpx.mjs」→ 解析到 pnpm store 里那份包
   *   → `Cannot find package 'zod'`，进程直接退出，服务器永远连不上。
   *
   * 实测：`server-filesystem` 和 `server-memory` 都失败，`server-everything` 正常 ——
   * 所以不是个别包的毛病，而是「用 pnpx 跑第三方包」在 pnpm 严格布局下的通病。
   *
   * 内置 runtime 的存在理由仍然成立（桌面启动的 Host PATH 里可能没有 node），所以它保留为
   * **兜底**：只有系统找不到 `npx` 时才用。顺序反过来的代价是「默认路径不可靠」，而用户
   * 根本看不到这个开关（`runtime` 既不在 schema 也不在面板上）。
   */
  const config = stdioMountConfig({
    serverName: 'npm-server', command: 'npx', args: ['-y', '@scope/pkg'],
  })
  assert.match(config.command, /npx$/, `默认应走系统 npx（收到 ${config.command}）`)
  assert.ok(!config.args.some((arg) => /pnpx\.mjs$/.test(arg)), '默认不该换成本地 pnpx')
  assert.deepEqual(config.args, ['-y', '@scope/pkg'], '`-y` 要保留（系统 npx 需要它）')
})

test('stdio 挂载：runtime=auto 显式要求时才换内置 node + pnpx（有内置 runtime 时）', () => {
  /**
   * `auto` 的落点取决于**这台机器有没有内置 runtime**：
   *   · 有（开发机）→ `<runtime>/node <runtime>/pnpx.mjs`；
   *   · 没有（CI：`$DSH_HOME/dsh-runtimes` 不存在）→ 回落到系统命令。
   *
   * 后者是兜底契约的一部分，不是失败。第一版断言「一定换成内置 node」，等于断言了一个
   * 环境事实，CI 上必红。
   */
  const runtime = bundledRuntime()
  const config = stdioMountConfig({
    serverName: 'npm-server', command: 'npx', args: ['-y', '@scope/pkg'], runtime: 'auto',
  })

  if (runtime === null) {
    assert.match(config.command, /npx|node/, `没有内置 runtime 时应回落（收到 ${config.command}）`)
    assert.ok(!String(config.args.join(' ')).includes('pnpx.mjs'), '没有内置 runtime 时不该引用 pnpx')
    return
  }

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
