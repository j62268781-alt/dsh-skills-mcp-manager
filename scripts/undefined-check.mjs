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
    const early = /error TS2448: Block-scoped variable '([^']+)' used before its declaration/.exec(line)
    const unassigned = /error TS2454: Variable '([^']+)' is used before being assigned/.exec(line)
    const name = missing?.[1] ?? typo?.[1] ?? early?.[1] ?? unassigned?.[1]
    if (name === undefined) continue
    if (ENVIRONMENT_NAMES.has(name)) continue
    found.push({ name, line: line.trim() })
  }
  return found
}

const here = dirname(fileURLToPath(import.meta.url))
const runTsc = (root, args) => {
  try {
    return execFileSync('npx', ['tsc', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return String(error.stdout ?? '') + String(error.stderr ?? '')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(here, '..')
  const hostOutput = runTsc(root, ['-p', 'tsconfig.json', '--noEmit', '--checkJs'])
  // The client half is JSX; the TDZ class (used before declaration) is what once
  // rendered a blank panel, so both roots are checked.
  const clientOutput = runTsc(root, [
    '--noEmit', '--allowJs', '--checkJs', '--target', 'es2022', '--module', 'esnext',
    '--moduleResolution', 'bundler', '--jsx', 'preserve', '--skipLibCheck',
    '--lib', 'es2022,dom', 'lib/src/client.js',
  ])
  const found = undefinedNames(hostOutput + '\n' + clientOutput)
  console.log(`  · 已检查 src/（Host）与 lib/src/client.js（Client）`)
  if (found.length > 0) {
    console.log('  ✗ 源码里存在未定义的名字（这类错误在真机上会让插件抛异常、整个 profile 被隔离）：')
    for (const item of found.slice(0, 10)) console.log('    ' + item.line)
    process.exit(1)
  }
  console.log('  ✓ 未定义名字检查通过（tsc --checkJs，已排除纯环境名）')
  process.exit(0)
}
