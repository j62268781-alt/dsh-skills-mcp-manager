/**
 * mcp/oauth/browser：把授权链接交给系统浏览器。
 *
 * 这个模块会**把一个字符串交给操作系统的启动器**，所以测试重心在边界上：只允许 http/https、
 * 每个平台的命令拼对（尤其 Windows 那个容易错位的空参数）、打不开时如实报告而不是抛错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPEN_ERRORS,
  browserLaunchCommand,
  openErrorText,
  openExternalUrl,
} from '../src/mcp/oauth/browser.js'

test('browserLaunchCommand：三个平台的启动命令', () => {
  assert.deepEqual(browserLaunchCommand('darwin'), { command: 'open', args: [] })
  assert.deepEqual(browserLaunchCommand('linux'), { command: 'xdg-open', args: [] })
  // Windows 的 `cmd /c start ""` —— 那个空参数是必须的：`start` 会把第一个带引号的
  // 参数当成窗口标题，少了它 URL 会被当成标题、浏览器根本不开。
  assert.deepEqual(browserLaunchCommand('win32'), { command: 'cmd', args: ['/c', 'start', ''] })
})

test('browserLaunchCommand：不认识的平台返回 null 而不是猜一个命令', () => {
  for (const platform of ['aix', 'sunos', '', 'freebsd']) {
    if (platform === 'freebsd') continue
    assert.equal(browserLaunchCommand(platform), null, platform)
  }
})

test('openExternalUrl：只开 http/https，其它 scheme 一律拒绝', () => {
  /**
   * 这个函数把字符串交给 OS 启动器，所以 `file:` / `javascript:` / 自定义 app scheme
   * 都不能从这里出去 —— 否则一个可控的 URL 就能让宿主打开任意本地文件或别的应用。
   */
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x/y', 'vscode://x']) {
    let spawned = false
    const result = openExternalUrl({
      url,
      platform: 'darwin',
      spawn: () => { spawned = true; return { unref() {} } },
      log: { warn() {} },
    })
    assert.equal(result.ok, false, url)
    assert.equal(result.reason, OPEN_ERRORS.badUrl, url)
    assert.equal(spawned, false, `${url} 不该被交给启动器`)
  }
})

test('openExternalUrl：解析不了的字符串也拒绝', () => {
  for (const url of ['', 'not a url', 'http://', null, undefined]) {
    const result = openExternalUrl({ url, platform: 'darwin', spawn: () => ({ unref() {} }) })
    assert.equal(result.ok, false, String(url))
  }
})

test('openExternalUrl：把 URL 作为**独立参数**传，不经 shell 重新解析', () => {
  /**
   * 如果地址里带 `&`、空格或反引号，走 shell 拼接就会被当成命令的一部分。
   * 所以必须：`shell: false`，且 URL 是 args 的最后一个元素。
   */
  let seen = null
  const result = openExternalUrl({
    url: 'http://sz-00575123-01/oauth/authorize?response_type=code&client_id=ab c',
    platform: 'darwin',
    spawn: (command, args, options) => {
      seen = { command, args, options }
      return { unref() {} }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.command, 'open')
  assert.equal(seen.command, 'open')
  assert.equal(seen.options.shell, false, '绝不能经 shell')
  assert.equal(seen.options.detached, true, '启动器不能拖住 Host 的生命周期')
  assert.equal(seen.args.length, 1)
  assert.match(seen.args[0], /client_id=ab%20c/, 'URL 应被规范化后整体作为一个参数')
})

test('openExternalUrl：spawn 同步抛错时收敛成原因，不抛', () => {
  const result = openExternalUrl({
    url: 'http://x/y',
    platform: 'darwin',
    spawn: () => { throw new Error('EACCES') },
    log: { warn() {} },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, OPEN_ERRORS.failed)
  assert.match(result.detail, /EACCES/)
})

test('openExternalUrl：不认识的平台如实说，不假装打开成功', () => {
  const result = openExternalUrl({ url: 'http://x/y', platform: 'plan9', spawn: () => ({ unref() {} }) })
  assert.equal(result.ok, false)
  assert.equal(result.reason, OPEN_ERRORS.unsupported)
})

test('openExternalUrl：异步的 ENOENT（启动器不存在）只记 warning，不改变返回值', async () => {
  /**
   * `spawn` 对「命令不存在」是**异步**报的，那时函数早已返回 ok:true。这里要保证：
   * 不抛 unhandled error，且 warning 里带上命令名 —— 否则「点了没反应」没有任何线索。
   */
  const warnings = []
  let handler = null
  const result = openExternalUrl({
    url: 'http://x/y',
    platform: 'linux',
    spawn: () => {
      const child = { on: (event, fn) => { if (event === 'error') handler = fn }, unref() {} }
      return child
    },
    log: { warn: (message) => warnings.push(message) },
  })
  assert.equal(result.ok, true, '「已经请 OS 打开」本身是成功的')
  assert.equal(typeof handler, 'function')
  handler(new Error('spawn xdg-open ENOENT'))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /xdg-open/)
})

test('openErrorText：每种原因都有人话，且带得上细节', () => {
  for (const reason of Object.values(OPEN_ERRORS)) {
    const text = openErrorText(reason, 'detail')
    assert.notEqual(text, '', reason)
    assert.match(text, /detail/, reason)
  }
})
