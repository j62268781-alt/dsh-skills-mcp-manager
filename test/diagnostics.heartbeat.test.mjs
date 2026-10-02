/** diagnostics/heartbeat 接口测试：写出的 JSON 可被外部读取。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beat, beatFile } from '../src/diagnostics/heartbeat.js'

const home = await mkdtemp(join(tmpdir(), 'smp-beat-'))
process.env.DSH_HOME = home

test('beatFile：指向 $DSH_HOME 下的心跳文件', () => {
  assert.equal(beatFile(), join(home, 'skills-mcp-panel.heartbeat.json'))
})

test('beat：写入可解析的 JSON，保留我们关心的字段', async () => {
  await beat({ at: '2026-10-02T00:00:00.000Z', tick: 7, rowOps: { pending: 1, applied: 2, error: null }, mounted: 3 })
  const parsed = JSON.parse(await readFile(beatFile(), 'utf8'))
  assert.equal(parsed.tick, 7)
  assert.equal(parsed.rowOps.applied, 2)
  assert.equal(parsed.mounted, 3)
  assert.ok(typeof parsed.lastBeat === 'object' && parsed.lastBeat !== null, '应带有合并用的 lastBeat')
})
