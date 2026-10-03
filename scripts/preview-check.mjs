/**
 * Preview gate: renders the bundled client in headless Chrome and asserts the
 * UI baseline. Any deviation exits non-zero, so it can gate a commit.
 *
 * Baseline (adjust here if the UI intentionally changes):
 *   entries 13 · tabs MCP（5）/ Skills（1）· stop buttons 4 · delete buttons 5 · no render error
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

// entries is the number of card identities actually rendered (6: the import card
// plus the five MCP rows). It used to be counted as a bare substring over the whole
// dump, which also matched the inlined stylesheet text — so it drifted with every
// CSS edit and reported 15 while only 6 elements existed.
const EXPECTED = { entries: 6, stops: 4, deletes: 5, tabs: 'MCP（5）|Skills（1）' }
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const previewDir = process.env.SMP_PREVIEW_DIR ?? '/tmp/preview'

if (!existsSync(previewDir)) {
  console.log(`  · 跳过预览门禁（没有 ${previewDir}）`)
  process.exit(0)
}

execFileSync('python3', ['build.py'], { cwd: previewDir })
const dom = execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--virtual-time-budget=3000', '--dump-dom', 'file:///tmp/preview/p-mcp.html?state=mcp',
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90_000 })

const count = (needle) => dom.split(needle).length - 1
const actual = {
  error: dom.includes('smp-error-msg'),
  // Count the class attribute, not the bare word: the inlined stylesheet also
  // mentions .smp-cardIdentity, which used to inflate this by one.
  entries: count('class="smp-cardIdentity"'),
  /** On mismatch, list what was actually rendered so the diff is obvious. */
  identityTexts: [...dom.matchAll(/class="smp-cardIdentity"[^>]*>([^<]*)/g)].map((m) => m[1].trim()),
  stops: count('>停用<'),
  deletes: count('>删除<'),
  tabs: (dom.match(/class="smp-tab"[^>]*>([^<]{1,20})</g) ?? [])
    .map((m) => m.replace(/.*>/, '').replace(/<$/, '')).join('|'),
}

const problems = []
if (actual.error) problems.push('页面出现渲染错误 (smp-error-msg)')
if (actual.entries !== EXPECTED.entries) {
  problems.push(`条目 ${actual.entries} ≠ ${EXPECTED.entries}`)
  problems.push(`  实际条目：${JSON.stringify(actual.identityTexts)}`)
}
if (actual.stops !== EXPECTED.stops) problems.push(`停用按钮 ${actual.stops} ≠ ${EXPECTED.stops}`)
if (actual.deletes !== EXPECTED.deletes) problems.push(`删除按钮 ${actual.deletes} ≠ ${EXPECTED.deletes}`)
if (actual.tabs !== EXPECTED.tabs) problems.push(`tab ${actual.tabs} ≠ ${EXPECTED.tabs}`)
if (problems.length > 0) {
  console.log('  ✗ 预览基线不符：')
  for (const p of problems) console.log('    ·', p)
  process.exit(1)
}
console.log(`  ✓ 预览基线通过：条目 ${actual.entries} · tab ${actual.tabs} · 停用 ${actual.stops} · 删除 ${actual.deletes}`)
