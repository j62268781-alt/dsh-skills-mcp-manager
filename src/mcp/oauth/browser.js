/**
 * 用系统默认浏览器打开授权链接。
 *
 * ## 为什么在 Host 侧做，而不是面板里 `window.open`
 *
 * 面板有两种宿主：
 *
 *   · **Web 模式**：面板跑在用户的浏览器里，`window.open` 会新开一个标签页 —— 可行，
 *     但那次授权是在**面板自己的浏览器**里完成的，和我们「拉起外部浏览器」的意图只是
 *     碰巧一致。
 *   · **桌面模式**：面板跑在 Electron 窗口里，`window.open` 开的是一个 **Electron 窗口**，
 *     不是用户的浏览器。授权页要求用户已登录中台，而登录态在系统浏览器里 —— 开成
 *     Electron 窗口等于让用户在新容器里再登录一次。
 *
 * 所以由 Host 调用系统命令打开，两种模式行为一致，也才是字面意义上的「外部浏览器」。
 *
 * ## 边界
 *
 * · **只开 http/https**。这个函数会把一个字符串交给操作系统的启动器，别的 scheme
 *   （`file:`、`javascript:`、自定义 app scheme）不该从这里出去。
 * · **绝不阻塞、绝不抛错**。浏览器打不开不该让授权失败 —— 链接仍然会显示在面板上，
 *   用户可以自己复制。所以失败只作为 `reason` 返回。
 * · **detached + unref**：`open`/`xdg-open` 在 macOS/Linux 上常常是**前台停留**的
 *   （它自己会退出，但会挂在父进程身上），不 detach 会把 Host 的进程生命周期拖住。
 * · 不传任何环境变量或凭据：命令里只有那个 URL。
 */

import { spawn as nodeSpawn } from 'node:child_process'

/** 打开失败的原因取值。 */
export const OPEN_ERRORS = Object.freeze({
  badUrl: 'not-an-http-url',
  unsupported: 'unsupported-platform',
  failed: 'launcher-failed',
})

/** 人话错误。 */
export function openErrorText(reason, detail) {
  const tail = typeof detail === 'string' && detail !== '' ? `：${detail}` : ''
  switch (reason) {
    case OPEN_ERRORS.badUrl:
      return `这不是一个可以打开的 http(s) 链接${tail}`
    case OPEN_ERRORS.unsupported:
      return `当前系统没有可用的浏览器启动方式${tail}`
    case OPEN_ERRORS.failed:
      return `拉起浏览器失败${tail}`
    default:
      return `打开浏览器失败${tail}`
  }
}

/**
 * 该平台的浏览器启动命令。
 *
 * `win32` 走 `cmd /c start`，那个空字符串参数是必须的：`start` 会把第一个带引号的参数
 * 当成窗口标题，少了它，URL 会被当成标题、浏览器根本不开。
 *
 * @param platform - `process.platform` 的取值。
 * @returns `{ command, args }`，或 null（不认识平台）。
 */
export function browserLaunchCommand(platform) {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [] }
    case 'win32':
      return { command: 'cmd', args: ['/c', 'start', ''] }
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      return { command: 'xdg-open', args: [] }
    default:
      return null
  }
}

/**
 * 打开一个 URL。
 *
 * @param options.url - 要打开的链接。
 * @param options.platform - 默认 `process.platform`（测试注入用）。
 * @param options.spawn - 默认 `node:child_process` 的 spawn（测试注入用）。
 * @param options.log - `{ warn }`：失败要留痕，否则「点了没反应」无从排查。
 * @returns `{ ok: true, command }` 或 `{ ok: false, reason, detail, text }`。永不抛错。
 */
export function openExternalUrl({ url, platform, spawn, log } = {}) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch (error) {
    const detail = String(error?.message ?? error)
    return { ok: false, reason: OPEN_ERRORS.badUrl, detail, text: openErrorText(OPEN_ERRORS.badUrl, detail) }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const detail = parsed.protocol
    return { ok: false, reason: OPEN_ERRORS.badUrl, detail, text: openErrorText(OPEN_ERRORS.badUrl, detail) }
  }

  const target = browserLaunchCommand(platform ?? process.platform)
  if (target === null) {
    const detail = String(platform ?? process.platform)
    return { ok: false, reason: OPEN_ERRORS.unsupported, detail, text: openErrorText(OPEN_ERRORS.unsupported, detail) }
  }

  const spawnFn = spawn ?? nodeSpawn
  if (typeof spawnFn !== 'function') {
    return { ok: false, reason: OPEN_ERRORS.unsupported, detail: 'no spawn', text: openErrorText(OPEN_ERRORS.unsupported) }
  }

  try {
    const child = spawnFn(target.command, [...target.args, parsed.href], {
      // `detached` + `unref`: the launcher must not keep the Host's event loop (or its process
      // group) alive. On macOS `open` returns immediately, but xdg-open can linger.
      detached: true,
      stdio: 'ignore',
      // No shell: the URL is an argument, never a command line to be re-parsed.
      shell: false,
    })
    // `error` fires for ENOENT (launcher missing) asynchronously; swallow it and log — the
    // caller already got `ok: true` for "we asked the OS", and the user still has the link.
    child?.on?.('error', (error) => {
      log?.warn?.(`dsh-skills-mcp-manager: 拉起浏览器失败（${target.command}）：${String(error?.message ?? error)}`)
    })
    child?.unref?.()
    return { ok: true, command: target.command }
  } catch (error) {
    const detail = String(error?.message ?? error)
    log?.warn?.(`dsh-skills-mcp-manager: 拉起浏览器失败：${detail}`)
    return { ok: false, reason: OPEN_ERRORS.failed, detail, text: openErrorText(OPEN_ERRORS.failed, detail) }
  }
}
