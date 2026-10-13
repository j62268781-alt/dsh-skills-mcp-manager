/**
 * 清掉 Host 半的编译产物。
 *
 * 为什么需要它：`tsc` 只增不删 —— 重命名或删除一个模块后，旧的 `.js` 会留在 `dist/`
 * 里继续被打包发布。本插件刚经历过一次：`src/mcp/watch.js` 被 `probe.js` 取代后，
 * `dist/mcp/watch.js` 仍在（且会被 npm 带上）。过期的死代码不该进发布物。
 *
 * 用 Node 而不是 `rm -rf`：这个仓库要在 Windows 上也能构建。
 */
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
rmSync(join(root, 'dist'), { recursive: true, force: true })
