/**
 * 连接状态标签与「重连」按钮。
 *
 * 这个功能存在的理由就是「服务器悄悄失效但界面什么都不说」，所以这里要钉住的正是
 * 那些**沉默失败**：
 *   · 已放弃重试必须给出显眼标签，而不是让卡片看起来和正常一样
 *   · 停用的条目不显示状态（没有连接可报告），而不是留着过期的「已连接」
 *   · Host 不支持重连时不给按钮（点了没反应的按钮比没有按钮更糟）
 *   · 点重连必须真的把请求写进设置，带对 tier/scope，面板才能路由回正确的连接
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle, textOf } from '../scripts/lib/client-harness.mjs'

const project = (over = {}) => ({
  scope: '/p/tcl', id: 'gitnexus', serverName: 'gitnexus', transport: 'streamable-http',
  url: 'http://x/mcp/coding', command: '', args: [], env: '', runtime: 'auto', source: '',
  headers: '', failOnStartupError: false, reconnectInitialDelayMs: '1000',
  reconnectMaxDelayMs: '', reconnectMaxAttempts: '', enabled: true, ...over,
})

const statusEntry = (over = {}) => ({
  serverName: 'gitnexus', tier: 'project', scope: '/p/tcl', status: 'gave-up',
  toolCount: 0, elapsedMs: 400000, budgetMs: 181000, remainingSeconds: 0, detail: '', ...over,
})

/** 全部标签文字，便于断言。 */
const tagTexts = (panel) => panel.findAll((node) => String(node.props.className ?? '').includes('smp-tag')).map((node) => textOf(node))

test('状态标签：已放弃重试时给出显眼的 danger 标签', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    servers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry()],
  }))
  try {
    const tags = panel.findAll((node) => String(node.props.className ?? '').includes('smp-tag'))
    const danger = tags.find((node) => node.props['data-tone'] === 'danger')
    assert.ok(danger !== undefined, `没有 danger 标签，实际标签：${JSON.stringify(tagTexts(panel))}`)
    assert.match(textOf(danger), /已放弃重试/)
  } finally {
    panel.restore()
  }
})

test('状态标签：未连接但仍在重试时给警示色，并标出预计剩余', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    servers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({ status: 'retrying', elapsedMs: 60000, remainingSeconds: 121 })],
  }))
  try {
    const warn = panel.findAll((node) => node.props['data-tone'] === 'warn')[0]
    assert.ok(warn !== undefined, '没有警示标签')
    const text = textOf(warn)
    assert.match(text, /重试中/)
    // 剩余时间是从预算推的，措辞必须说成「预计」
    assert.match(text, /预计剩 121s/)
  } finally {
    panel.restore()
  }
})

test('状态标签：已连接显示工具数', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    servers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({ status: 'connected', toolCount: 12, elapsedMs: 0 })],
  }))
  try {
    const ok = panel.findAll((node) => node.props['data-tone'] === 'ok')[0]
    assert.ok(ok !== undefined, '已连接没有 ok 标签')
    assert.match(textOf(ok), /已连接 · 12 个工具/)
  } finally {
    panel.restore()
  }
})

test('状态标签：停用的条目不显示连接状态', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    servers: [project({ enabled: false })], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({ status: 'connected', toolCount: 3 })],
  }))
  try {
    const texts = tagTexts(panel)
    assert.ok(texts.includes('已停用'), `缺少「已停用」标签：${JSON.stringify(texts)}`)
    assert.ok(!texts.some((text) => text.includes('已连接')), `停用条目仍显示连接状态：${JSON.stringify(texts)}`)
  } finally {
    panel.restore()
  }
})

test('重连按钮：点了会把请求写进设置（带 tier/scope/nonce）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    servers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry()],
  }))
  const { doc } = panel
  try {
    panel.click(panel.byText('重连'))
    const request = doc.reconnectRequest
    assert.ok(request, '点击重连后没有写 reconnectRequest')
    assert.equal(request.tier, 'project')
    assert.equal(request.serverName, 'gitnexus')
    assert.equal(request.scope, '/p/tcl', 'scope 必须带上，否则同名的全局行会被误重连')
    assert.ok(String(request.nonce).length > 0, '缺少 nonce，结果无法路由回来')
  } finally {
    panel.restore()
  }
})

test('重连按钮：已连接时不给（没什么可重连的）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    servers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({ status: 'connected', toolCount: 5 })],
  }))
  try {
    assert.equal(panel.byText('重连'), null, '已连接的条目不该出现重连按钮')
  } finally {
    panel.restore()
  }
})

test('重连按钮：Host 不支持时不给（避免点了没反应）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    servers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true,
    serverStatus: [statusEntry()],
  }))
  try {
    assert.equal(panel.byText('重连'), null, 'reconnectReady 缺失时不该出现重连按钮')
  } finally {
    panel.restore()
  }
})

test('状态标签：观测机制不可用时显示「状态未知」，而不是静默留白', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    servers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({ status: 'unknown' })],
  }))
  try {
    const texts = tagTexts(panel)
    assert.ok(texts.includes('状态未知'), `观测不可用时应如实说明：${JSON.stringify(texts)}`)
    // 「不知道」不能给重连按钮 —— 那是给「确定没连上」用的
    assert.equal(panel.byText('重连'), null, '状态未知时不该出现重连按钮')
  } finally {
    panel.restore()
  }
})

test('全局行也会显示状态标签', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [{
      entryId: 'include:mcp-deepwiki', serverName: 'deepwiki', transport: 'streamable-http',
      target: 'https://mcp.deepwiki.com/mcp', command: '', args: '', env: '', headersText: '',
      failOnStartupError: false, reconnectInitialDelayMs: '', reconnectMaxDelayMs: '', reconnectMaxAttempts: '',
      enabled: true, phase: 'active',
    }],
    rowOpsReady: true, reconnectReady: true,
    serverStatus: [{ ...statusEntry({ serverName: 'deepwiki', tier: 'global', scope: '' }) }],
  }))
  try {
    const danger = panel.findAll((node) => node.props['data-tone'] === 'danger')[0]
    assert.ok(danger !== undefined, `全局行没有状态标签：${JSON.stringify(tagTexts(panel))}`)
    assert.match(textOf(danger), /已放弃重试/)
  } finally {
    panel.restore()
  }
})
