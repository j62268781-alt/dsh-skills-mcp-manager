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
import { bootPanel, emptyDoc, skipWithoutBundle, textOf, visit } from '../scripts/lib/client-harness.mjs'

/**
 * A project-scoped row, in the shape the Host now projects from `mcp-client` rows.
 *
 * This used to be a `config.servers` entry: project servers lived in a field the plugin
 * owned, while global ones were rows in the profile patch. Both tiers are rows now, and
 * `scope` is the only difference — so the fixture is a row, not a bespoke object.
 */
const project = (over = {}) => ({
  entryId: 'mcp-gitnexus', scope: '/p/tcl', serverName: 'gitnexus', transport: 'streamable-http',
  target: 'http://x/mcp/coding', command: '', args: '', env: '', headersText: '',
  failOnStartupError: false, reconnectInitialDelayMs: '1000',
  reconnectMaxDelayMs: '', reconnectMaxAttempts: '', enabled: true, phase: 'active', ...over,
})

const statusEntry = (over = {}) => ({
  serverName: 'gitnexus', tier: 'project', scope: '/p/tcl', status: 'gave-up',
  toolCount: 0, elapsedMs: 400000, budgetMs: 181000, remainingSeconds: 0, detail: '', ...over,
})

/** 所有状态圆点的取值（`data-dot`），便于断言颜色档位。 */
const dotTones = (panel) => panel.findAll((node) => node.props.className === 'smp-dot').map((node) => node.props['data-dot'])

/**
 * 启用开关，按**语义契约**查找。
 *
 * 卡片改用宿主自己的 `Switch` 之后，它的 className 是宿主 CSS module 的哈希名，
 * 按 `className === 'smp-switch'` 匹配会直接失效。`role=switch` + `aria-checked`
 * 是官方组件与我们的回退分支共同保证的契约，所以断言契约而不是任一实现的样式。
 */
const findSwitch = (panel) => panel.findAll((node) => node.props?.role === 'switch')[0]

/**
 * 某一个圆点档位对应的状态行文字。
 *
 * 状态行是「圆点 + 文字 + 数字」三个兄弟节点（见 `statusDot`），所以要按同一个
 * `.smp-status` 分组找，不能只按 `data-dot` 取文字。`visit` 是深度优先，所以
 * 父节点命中的那个区间内才会包含它自己的子圆点。
 */
const statusTextOf = (panel, dot) => {
  const lines = panel.findAll((node) => String(node.props.className ?? '') === 'smp-status')
  for (const line of lines) {
    const dots = []
    visit(line, (child) => { if (child.props?.['data-dot'] !== undefined) dots.push(child.props['data-dot']) })
    if (dots.includes(dot)) return textOf(line)
  }
  return ''
}

test('状态圆点：已放弃重试用红点', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry()],
  }))
  try {
    assert.ok(dotTones(panel).includes('danger'), `没有 danger 圆点，实际：${JSON.stringify(dotTones(panel))}`)
    assert.match(statusTextOf(panel, 'danger'), /已放弃重试/)
  } finally {
    panel.restore()
  }
})

test('状态圆点：连接中给黄点，并标出预计剩余', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({ status: 'retrying', elapsedMs: 60000, remainingSeconds: 121 })],
  }))
  try {
    assert.ok(dotTones(panel).includes('warn'), `没有 warn 圆点，实际：${JSON.stringify(dotTones(panel))}`)
    const text = statusTextOf(panel, 'warn')
    // 「连接中」同时覆盖首次连接与断线重试：对用户来说是同一件事，两档都不需要他动手。
    assert.match(text, /连接中/)
    // 剩余时间是从预算推的，措辞必须说成约数
    assert.match(text, /约 121s/)
  } finally {
    panel.restore()
  }
})

test('状态圆点：已连接给绿点并显示工具数', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({ status: 'connected', toolCount: 12, elapsedMs: 0 })],
  }))
  try {
    assert.ok(dotTones(panel).includes('ok'), `没有 ok 圆点，实际：${JSON.stringify(dotTones(panel))}`)
    const text = statusTextOf(panel, 'ok')
    assert.match(text, /可用/)
    assert.match(text, /12 个工具/)
  } finally {
    panel.restore()
  }
})

test('停用的条目：开关显示为关，且不显示状态圆点', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [project({ enabled: false })], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({ status: 'connected', toolCount: 3 })],
  }))
  try {
    // 「停用」这件事现在由开关表达（它同时说状态和提供切换），不再是一个「已停用」标签，
    // 也不再需要「启用/停用」两个按钮 —— 一列卡片扫下来开关的开关态就能看明白。
    const sw = findSwitch(panel)
    assert.ok(sw !== undefined, '停用条目没有开关')
    assert.equal(sw.props['aria-checked'], false, '停用条目的开关应显示为关')
    // 关键：没有连接可报告，就不该留一个过期的绿点说「可用」
    assert.deepEqual(dotTones(panel), [], `停用条目仍显示连接状态圆点：${JSON.stringify(dotTones(panel))}`)
  } finally {
    panel.restore()
  }
})

test('开关：点一下会把 toggle 行操作写进队列（乐观显示为关）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry()],
  }))
  const { doc } = panel
  try {
    const sw = findSwitch(panel)
    assert.equal(sw.props['aria-checked'], true, '启用的条目开关应为开')
    panel.click(sw)
    const op = (doc.rowOps ?? []).find((o) => o.op === 'toggle')
    assert.ok(op, '点击开关后没有写 toggle 行操作')
    assert.equal(op.entryId, 'mcp-gitnexus')
    assert.equal(op.enabled, false, '从「开」点一下应变「关」')
  } finally {
    panel.restore()
  }
})

test('重连在 popup 里：点了会把请求写进设置（带 tier/scope/nonce）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry()],
  }))
  const { doc } = panel
  try {
    // 重连现在收在「…」菜单里，先开菜单
    panel.click(panel.findAll((node) => String(node.props.className ?? '') === 'smp-moreTrigger')[0])
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

/**
 * Open the row's `…` popup and return the text of its items.
 *
 * 重连/编辑/删除 都收进了 popup（三个按钮并排会把服务器名挤出视野），所以断言它们
 * 存不存在必须先开菜单。返回空串表示这张卡片根本没有「…」（例如 Host 不支持行操作）。
 */
const openMenuText = (panel, index = 0) => {
  const triggers = panel.findAll((node) => String(node.props.className ?? '') === 'smp-moreTrigger')
  if (triggers.length <= index) return ''
  panel.click(triggers[index])
  const menu = panel.find((node) => String(node.props.className ?? '') === 'smp-menu')
  return menu === null ? '' : textOf(menu)
}

test('重连：已连接时菜单里没有这一项（没什么可重连的）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({ status: 'connected', toolCount: 5 })],
  }))
  try {
    const menu = openMenuText(panel)
    assert.ok(!menu.includes('重连'), `已连接时不该有重连项：${JSON.stringify(menu)}`)
    // 但编辑/删除仍然要在 —— 菜单只有一个动作就说明筛过头了
    assert.ok(menu.includes('编辑') && menu.includes('删除'), `菜单项不完整：${JSON.stringify(menu)}`)
  } finally {
    panel.restore()
  }
})

test('重连：Host 不支持时不给（避免点了没反应）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true,
    serverStatus: [statusEntry()],
  }))
  try {
    // 状态是 gave-up（本该给重连），但 Host 没发布 reconnectReady → 不该给
    assert.ok(!openMenuText(panel).includes('重连'), 'reconnectReady 缺失时不该出现重连项')
  } finally {
    panel.restore()
  }
})

test('状态圆点：观测机制不可用时显示「状态未知」灰点，而不是静默留白', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({ status: 'unknown' })],
  }))
  try {
    assert.ok(dotTones(panel).includes('neutral'), `观测不可用时应给中性圆点：${JSON.stringify(dotTones(panel))}`)
    assert.match(statusTextOf(panel, 'neutral'), /状态未知/)
    // 「不知道」不能给重连 —— 那是给「确定没连上」用的
    assert.ok(!openMenuText(panel).includes('重连'), '状态未知时不该出现重连项')
  } finally {
    panel.restore()
  }
})

test('全局行也会显示状态圆点', { skip: skipWithoutBundle() }, async () => {
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
    assert.ok(dotTones(panel).includes('danger'), `全局行没有状态圆点：${JSON.stringify(dotTones(panel))}`)
    assert.match(statusTextOf(panel, 'danger'), /已放弃重试/)
  } finally {
    panel.restore()
  }
})

/** 一条全局（配置文件）行 —— 全局层的卡片走的是 profileCard。 */
const profileServer = (over = {}) => ({
  entryId: 'include:mcp-protected', serverName: 'protected', transport: 'streamable-http',
  target: 'https://api.example.com/mcp', command: '', args: '', env: '', headersText: '',
  failOnStartupError: false, reconnectInitialDelayMs: '', reconnectMaxDelayMs: '', reconnectMaxAttempts: '',
  enabled: true, phase: 'active', ...over,
})

test('需要授权：给黄点而不是红点（它不是故障）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [profileServer()], rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({
      serverName: 'protected', tier: 'global', scope: '', status: 'needs-auth',
      detail: '服务器要求先授权（OAuth）才能连接，这不是故障：需要 files:read 范围',
    })],
  }))
  try {
    const tones = dotTones(panel)
    // 「需要授权」与「连接中」同为黄色：主题里除红/绿只有一档状态色，而两者都是
    // 「有一件事在等」—— 区别是前者等用户，后者等服务器。区分靠文字，不靠颜色。
    assert.ok(tones.includes('warn'), `需要授权应给黄点：${JSON.stringify(tones)}`)
    assert.match(statusTextOf(panel, 'warn'), /需要授权/)
    // 红色会让人以为服务器坏了 —— 而这恰恰是「需要授权」要避免的误解
    assert.ok(!tones.includes('danger'), '需要授权不该用红色')
  } finally {
    panel.restore()
  }
})

test('需要授权：展开卡片给出下一步，且菜单里**没有**重连', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [profileServer()], rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({
      serverName: 'protected', tier: 'global', scope: '', status: 'needs-auth',
      detail: '服务器要求先授权（OAuth）才能连接，这不是故障：需要 files:read 范围',
    })],
  }))
  try {
    // 重连治不了缺授权，给这一项等于教用户反复点一个无效操作
    assert.ok(!openMenuText(panel).includes('重连'), '需要授权时不该出现重连项')
    // 展开这张卡片（收起状态下说明文字不渲染）
    const toggle = panel.findAll((node) => String(node.props.className ?? '').includes('smp-cardToggle'))[0]
    assert.ok(toggle !== undefined, '没有卡片可展开')
    panel.click(toggle)
    const text = panel.text()
    // 必须转述 Host 的判断（含「不是故障」），否则用户会按「它坏了」去排查
    assert.match(text, /不是故障/)
    assert.match(text, /files:read/)
    // 必须给出可执行的下一步：DSH 的客户端不带 OAuth，只能靠凭据
    assert.match(text, /Authorization/)
  } finally {
    panel.restore()
  }
})

test('已连接时即使带着陈旧的授权挑战也不显示「需要授权」', { skip: skipWithoutBundle() }, async () => {
  // 挑战是缓存观测值，连接状态才是当下事实：反过来会把一台已经连上的服务器标成要授权
  const panel = await bootPanel(emptyDoc({
    profileServers: [profileServer()], rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({
      serverName: 'protected', tier: 'global', scope: '', status: 'connected', toolCount: 7,
    })],
  }))
  try {
    const tones = dotTones(panel)
    assert.ok(!tones.includes('auth'), `已连接时不该说需要授权：${JSON.stringify(tones)}`)
    assert.ok(tones.includes('ok'), `已连接应给绿点：${JSON.stringify(tones)}`)
  } finally {
    panel.restore()
  }
})

test('需要授权：展开时如果没有 Host 说明，也要给出一个默认说明', { skip: skipWithoutBundle() }, async () => {
  // detail 可能为空（旧 Host／尚未探到）。此时不能只留一个「需要授权」标签就完事 ——
  // 用户会按「服务器坏了」去排查，而这正是这个状态要防止的误解。
  const panel = await bootPanel(emptyDoc({
    profileServers: [profileServer()], rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry({ serverName: 'protected', tier: 'global', scope: '', status: 'needs-auth', detail: '' })],
  }))
  try {
    const toggle = panel.findAll((node) => String(node.props.className ?? '').includes('smp-cardToggle'))[0]
    panel.click(toggle)
    const text = panel.text()
    assert.match(text, /不是故障/)
    assert.match(text, /Authorization/)
  } finally {
    panel.restore()
  }
})
