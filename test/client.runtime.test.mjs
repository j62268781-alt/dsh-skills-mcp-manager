import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle } from '../scripts/lib/client-harness.mjs'

const row = {
  entryId: 'mcp-wiki', serverName: 'wiki', scope: 'global', transport: 'streamable-http',
  target: 'https://example.invalid/mcp', enabled: true, phase: 'active',
}
const payload = {
  serverTools: [{ serverName: 'wiki', tools: [{ name: 'mcp__wiki__live', description: 'runtime description' }] }],
  serverToolsError: { reason: '', detail: '' },
  serverStatus: [{ serverName: 'wiki', tier: 'global', scope: '', status: 'connected', toolCount: 1 }],
}

test('panel reads same-origin runtime data instead of legacy settings and refreshes on expansion', { skip: skipWithoutBundle() }, async () => {
  const requests = []
  const panel = await bootPanel(emptyDoc({
    profileServers: [row],
    serverTools: [{ serverName: 'wiki', tools: [{ name: 'obsolete-tool' }] }],
  }), {
    fetch: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, json: async () => payload }
    },
  })
  try {
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/dsh-skills-mcp-manager/runtime')
    assert.equal(requests[0].options.credentials, 'same-origin')
    assert.equal(requests[0].options.cache, 'no-store')
    panel.click(panel.byClass('smp-cardToggle'))
    await panel.settle()
    assert.equal(requests.length, 2)
    assert.match(panel.text(), /runtime description/)
    assert.doesNotMatch(panel.text(), /obsolete-tool/)
  } finally { panel.restore() }
})

test('failed runtime refresh clears stale connected state and reports the failure', { skip: skipWithoutBundle() }, async () => {
  let fail = false
  let refresh
  const panel = await bootPanel(emptyDoc({ profileServers: [row] }), {
    fetch: async () => fail ? { ok: false, status: 503 } : { ok: true, json: async () => payload },
    onInterval: (fn, ms) => { if (ms === 5000) refresh = fn },
  })
  try {
    assert.match(panel.text(), /可用/)
    fail = true
    await refresh()
    await panel.settle()
    assert.doesNotMatch(panel.text(), /可用/)
    assert.match(panel.text(), /状态未知/)
    panel.click(panel.byClass('smp-cardToggle'))
    await panel.settle()
    assert.match(panel.text(), /无法读取 Host 运行时数据.*HTTP 503/)
  } finally { panel.restore() }
})
