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
  servers: [row],
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

test('运行时轮询：hidden 只降频、不停止 —— 倒计时不会冻住', { skip: skipWithoutBundle() }, async () => {
  /**
   * 真机现象：卡片上的「连接中 约 54s」**不会自己走**，切换/点一下才刷新。
   *
   * 根因是那句 `if (document.visibilityState === 'hidden') return` —— 它把「不可见」当成
   * 「不该更新」。页面一旦被判成 hidden，倒计时就永远停在某个数字上，界面上没有任何迹象
   * 说明它在冻着；用户唯一能做的是切换卡片，而那会重建 effect、立刻拉一次，于是现象变成
   * 「点一下才刷新」。
   *
   * 现在的契约：**hidden 时降频到 15s，不停止**。这条测试做两件事：
   *   1. hidden 且距上次拉取很近 → 5s 定时器不发请求（降频生效，不空转）；
   *   2. hidden 但已过 15s → 必须发请求（不会冻住）。
   * 第 2 点是关键：把 guard 写回 `return` 会让它失败。
   */
  let fetches = 0
  let refresh
  const panel = await bootPanel(emptyDoc({ profileServers: [row] }), {
    visibilityState: 'hidden',
    fetch: async () => {
      fetches += 1
      return { ok: true, json: async () => payload }
    },
    onInterval: (fn, ms) => { if (ms === 5000) refresh = fn },
  })
  try {
    await panel.settle()
    assert.ok(fetches >= 1, '首次加载应拉取一次')
    const afterBoot = fetches

    // ① 刚拉过 → 定时器再跑一次应被 15s 门槛挡住
    await refresh()
    await panel.settle()
    assert.equal(fetches, afterBoot, `hidden 且刚拉过时不该空转（实测 ${afterBoot} → ${fetches}）`)

    // ② 把时间推过 15s 门槛 → 必须真的再拉一次
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 16000
      await refresh()
      await panel.settle()
    } finally {
      Date.now = realNow
    }
    assert.ok(
      fetches > afterBoot,
      `hidden 超时后必须继续拉取（实测 ${afterBoot} → ${fetches}）—— 冻住的话倒计时就永远不动`,
    )
  } finally {
    panel.restore()
  }
})
