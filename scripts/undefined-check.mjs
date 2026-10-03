/**
 * Fail the build when the source calls a name that does not exist.
 *
 * Why: `invalidate()` in a channel handler was never defined anywhere. Node's
 * syntax check and the unit tests both passed, and the first real request threw
 * out of the plugin — which made DSH quarantine the user's whole profile patch.
 * `tsc --checkJs` does report `TS2304: Cannot find name 'invalidate'`; the only
 * problem is that it also reports names that just lack environment typings here
 * (setInterval, process, node: builtins), so those are allow-listed.
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Names that are real globals/modules but have no typings in this project. */
export const ENVIRONMENT_NAMES = new Set([
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate',
  'process', 'console', 'Buffer', 'require', 'module', 'exports', 'globalThis', 'fetch',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'structuredClone', 'queueMicrotask',
  'AbortController', 'AbortSignal', 'performance', 'crypto', '__dirname', '__filename',
])

/** Extract TS2304/TS2552 names from tsc output, minus the allow-listed ones. */
export function undefinedNames(output) {
  const found = []
  for (const line of String(output).split('\n')) {
    const missing = /error TS2304: Cannot find name '([^']+)'/.exec(line)
    const typo = /error TS2552: Cannot find name '([^']+)'/.exec(line)
    const name = missing?.[1] ?? typo?.[1]
    if (name === undefined) continue
    if (ENVIRONMENT_NAMES.has(name)) continue
    found.push({ name, line: line.trim() })
  }
  return found
}

const here = dirname(fileURLToPath(import.meta.url))
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(here, '..')
  let output = ''
  try {
    output = execFileSync('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit', '--checkJs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    output = String(error.stdout ?? '') + String(error.stderr ?? '')
  }
  const found = undefinedNames(output)
  if (found.length > 0) {
    console.log('  ✗ 源码里存在未定义的名字（这类错误在真机上会让插件抛异常、整个 profile 被隔离）：')
    for (const item of found.slice(0, 10)) console.log('    ' + item.line)
    process.exit(1)
  }
  console.log('  ✓ 未定义名字检查通过（tsc --checkJs，已排除纯环境名）')
  process.exit(0)
}
