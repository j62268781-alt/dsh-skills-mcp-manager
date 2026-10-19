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

/**
 * 页面**正文**（排除内联的样式表）。
 *
 * `panel.text()` 把 `lib/client.js` 里内联的整份 CSS 也拼进来了，而那份 CSS 的注释里就写着
 * 「授权链接」这类词 —— 用它断言「页面上出现了授权链接」会**永远通过**，是一条不会失败的
 * 断言。样式表是单个字符串节点，这里从第一个元素节点往下收集，跳过它。
 */
const bodyText = (panel) => {
  const parts = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node === null || node === undefined || typeof node !== 'object') return
    if (typeof node.type === 'string') {
      for (const child of node.children ?? []) {
        if (typeof child === 'string' || typeof child === 'number') parts.push(String(child))
        else walk(child)
      }
      return
    }
    walk(node.children)
  }
  walk(panel.runtime?.tree)
  return parts.join(' ').replace(/\s+/g, ' ')
}

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

test('开关：点一下把 toggle 命令发给 Host（乐观显示为关，无需等待）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry()],
  }))
  const { doc } = panel
  try {
    const sw = findSwitch(panel)
    assert.equal(sw.props['aria-checked'], true, '启用的条目开关应为开')
    panel.click(sw)
    // 乐观：点完立刻显示为关，不等 Host 回来（这正是这次改动的目的）
    assert.equal(findSwitch(panel).props['aria-checked'], false, '点完应立刻显示为关')

    await panel.settle()
    const op = (doc.rowCommands ?? []).find((o) => o.op === 'toggle')
    assert.ok(op, '点击开关后没有把 toggle 命令发给 Host')
    assert.equal(op.entryId, 'mcp-gitnexus')
    assert.equal(op.enabled, false, '从「开」点一下应变「关」')
  } finally {
    panel.restore()
  }
})

test('开关：Host 拒绝时回滚乐观状态并说明原因', { skip: skipWithoutBundle() }, async () => {
  /**
   * 乐观 UI 只有在**失败可见**时才诚实。卡片/开关在点击瞬间就动了，所以被拒绝的命令必须
   * 把它放回去 —— 否则用户看到的是一个配置文件里并不存在的状态，比原来的等待更糟。
   */
  const panel = await bootPanel(emptyDoc({
    profileServers: [project()], currentWorkspace: '/p/tcl', rowOpsReady: true, reconnectReady: true,
    serverStatus: [statusEntry()],
    rowCommandResult: { ok: false, reason: 'row "mcp-gitnexus" not found in the profile patch' },
  }))
  try {
    panel.click(findSwitch(panel))
    await panel.settle()
    assert.equal(findSwitch(panel).props['aria-checked'], true, '命令失败后开关应回到原状态')
    assert.match(panel.text(), /not found in the profile patch/, '失败原因要显示出来')
  } finally {
    panel.restore()
  }
})

test('重连在 popup 里：点了 POST /reconnect（带 tier/scope）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [project()], currentWorkspace: '/p/tcl',
    serverStatus: [statusEntry()],
  }))
  const { doc } = panel
  try {
    // 重连收在「…」菜单里，先开菜单
    panel.click(panel.findAll((node) => String(node.props.className ?? '') === 'smp-moreTrigger')[0])
    panel.click(panel.byText('重连'))
    await panel.settle()
    const request = (doc.reconnectCommands ?? []).at(-1)
    assert.ok(request, '点击重连后没有 POST /reconnect')
    assert.equal(request.tier, 'project')
    assert.equal(request.serverName, 'gitnexus')
    assert.equal(request.scope, '/p/tcl', 'scope 必须带上，否则同名的全局行会被误重连')
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

test('重连：Host 没有路由时，点击后把失败原因显示出来（不静默）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [project()], currentWorkspace: '/p/tcl',
    serverStatus: [statusEntry()],
  }), {
    fetch: async (url) => {
      if (String(url).endsWith('/runtime')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            serverTools: [], serverToolsError: { reason: '', detail: '' },
            serverStatus: [statusEntry()], servers: [project()],
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    },
  })
  try {
    panel.click(panel.findAll((node) => String(node.props.className ?? '') === 'smp-moreTrigger')[0])
    panel.click(panel.byText('重连'))
    await panel.settle()
    assert.match(panel.text(), /没有重连路由/, 'Host 不支持时要把原因显示出来')
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

test('需要授权：OAuth 不可用时给手贴 header 的建议 + 原因，且**不给**按钮', { skip: skipWithoutBundle() }, async () => {
  // 这是「装不上就如实说」的那一支。它比另一支更重要：一个点了永远不会成功的按钮，
  // 会让用户以为是自己操作错了 —— 比没有按钮更糟。
  const panel = await bootPanel(emptyDoc({
    profileServers: [profileServer()], rowOpsReady: true, reconnectReady: true,
    oauthState: { ready: false, reason: 'mcp-sdk-not-resolvable', detail: '当前 DSH 运行时里找不到 MCP SDK', sdkVersion: '', redirectUri: '' },
    oauthServers: {},
    serverStatus: [statusEntry({
      serverName: 'protected', tier: 'global', scope: '', status: 'needs-auth',
      detail: '服务器要求先授权（OAuth）才能连接，这不是故障',
    })],
  }))
  try {
    const toggle = panel.findAll((node) => String(node.props.className ?? '').includes('smp-cardToggle'))[0]
    panel.click(toggle)
    const text = bodyText(panel)
    assert.match(text, /Authorization/, '要给出可执行的替代做法')
    assert.match(text, /找不到 MCP SDK/, 'Host 给出的原因必须逐字显示，否则用户不知道该怎么修')
    assert.ok(!text.includes('复制链接'), 'OAuth 不可用时不该出现授权链接')
    const buttons = panel.findAll((node) => String(node.props.className ?? '').includes('smp-button'))
      .map((node) => textOf(node))
    assert.ok(!buttons.some((label) => label === '授权'), `OAuth 不可用时不该出现授权按钮：${JSON.stringify(buttons)}`)
  } finally {
    panel.restore()
  }
})

test('需要授权：OAuth 可用时给授权按钮与授权链接', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [profileServer()], rowOpsReady: true, reconnectReady: true,
    oauthState: { ready: true, reason: '', detail: '', sdkVersion: '2.2.0', redirectUri: 'http://127.0.0.1:3080/dsh-skills-mcp-manager/oauth/callback' },
    // 这台服务器正等着用户去授权：Host 已经把链接记下来了
    oauthServers: {
      protected: {
        present: false, refreshable: false, waiting: true,
        authorizeUrl: 'https://as.example.com/authorize?client_id=cid&state=abc',
        expiresAt: '', expired: false, at: '',
      },
    },
    serverStatus: [statusEntry({
      serverName: 'protected', tier: 'global', scope: '', status: 'needs-auth',
      detail: '服务器要求先授权（OAuth）才能连接，这不是故障',
    })],
  }))
  try {
    const toggle = panel.findAll((node) => String(node.props.className ?? '').includes('smp-cardToggle'))[0]
    panel.click(toggle)
    const text = bodyText(panel)
    const buttons = panel.findAll((node) => String(node.props.className ?? '').includes('smp-button'))
      .map((node) => textOf(node))
    assert.ok(buttons.includes('授权'), `OAuth 可用时应给授权按钮：${JSON.stringify(buttons)}`)
    assert.match(text, /不是故障/, '仍然必须点明这不是故障')
    // 授权链接来自 Host 投影（transport 自己撞上 401 时也会记录）。它在只读输入框的 `value`
    // 里而不是文本节点里 —— 那是刻意的：链接很长，纯文本没法完整复制。
    const urlInputs = panel.findAll((node) => node.type === 'input' && node.props.readOnly === true)
      .map((node) => String(node.props.value ?? ''))
    assert.ok(
      urlInputs.some((value) => value.includes('as.example.com/authorize')),
      `要把授权链接放进可复制的输入框：${JSON.stringify(urlInputs)}`,
    )
    assert.match(text, /复制链接/, 'DSH 官方登录也是「复制链接」而不是自动开浏览器')
    // 没有令牌时不该出现「清除凭据」——那会让用户以为已经授权过
    assert.ok(!buttons.includes('清除凭据'), `未授权时不该出现清除凭据：${JSON.stringify(buttons)}`)
  } finally {
    panel.restore()
  }
})

test('需要授权：已经有可刷新令牌时给「清除凭据」', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [profileServer()], rowOpsReady: true, reconnectReady: true,
    oauthState: { ready: true, reason: '', detail: '', sdkVersion: '2.2.0', redirectUri: '' },
    oauthServers: {
      protected: {
        present: true, refreshable: true, waiting: false, authorizeUrl: '',
        expiresAt: '2026-10-19T12:00:00.000Z', expired: false, at: '2026-10-19T11:00:00.000Z',
      },
    },
    serverStatus: [statusEntry({
      serverName: 'protected', tier: 'global', scope: '', status: 'needs-auth', detail: '',
    })],
  }))
  try {
    const toggle = panel.findAll((node) => String(node.props.className ?? '').includes('smp-cardToggle'))[0]
    panel.click(toggle)
    const buttons = panel.findAll((node) => String(node.props.className ?? '').includes('smp-button'))
      .map((node) => textOf(node))
    assert.ok(buttons.includes('清除凭据'), `有凭据时应能清除：${JSON.stringify(buttons)}`)
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

test('需要授权：已有凭据但服务器仍拒绝时，按钮说「重新授权」并解释原因', { skip: skipWithoutBundle() }, async () => {
  /**
   * 真机撞到的自相矛盾：`…` 菜单说「重新授权」（因为凭据确实在磁盘上），正文按钮却说
   * 「授权」—— 同一个动作两个名字，用户会以为按钮要重新走一遍全新的流程。
   *
   * 两个入口必须用**同一个判据**（`oauthServers[s].present`）。而且此时不该再暗示
   * 「还没授权」：凭据在、服务器仍 401，说明是**服务器不接受这份令牌**，要单独说清楚，
   * 否则用户重试到天亮也不会好。
   */
  const panel = await bootPanel(emptyDoc({
    profileServers: [profileServer()], rowOpsReady: true, reconnectReady: true,
    oauthState: { ready: true, reason: '', detail: '', sdkVersion: '2.2.0', redirectUri: 'http://127.0.0.1:3080/dsh-skills-mcp-manager/oauth/callback' },
    oauthServers: {
      protected: {
        present: true, refreshable: true, waiting: false, authorizeUrl: '',
        // 一小时后过期 —— 令牌本身是有效的
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), expired: false, at: '',
      },
    },
    serverStatus: [statusEntry({
      serverName: 'protected', tier: 'global', scope: '', status: 'needs-auth',
      detail: '服务器要求先授权（OAuth）才能连接，这不是故障',
    })],
  }))
  try {
    panel.click(panel.find((node) => String(node.props.className ?? '').includes('smp-cardToggle')))
    const buttons = panel.findAll((node) => String(node.props.className ?? '').includes('smp-button'))
      .map((node) => textOf(node))
    assert.ok(buttons.includes('重新授权'), `有凭据时按钮应说「重新授权」：${JSON.stringify(buttons)}`)
    assert.equal(buttons.includes('授权'), false, '不该同时出现一个「授权」按钮')

    const text = bodyText(panel)
    assert.match(text, /仍然拒绝了连接/, '要说明是服务器不接受这份令牌，而不是「还没授权」')
    assert.match(text, /重新授权通常能解决/)

    // 菜单里的入口用同一个判据
    const menu = panel.openMenu(0)
    assert.ok(menu !== null)
    const labels = panel.findAll((node) => String(node.props.className ?? '') === 'smp-menuItem').map((node) => textOf(node).trim())
    assert.ok(labels.includes('重新授权'), `菜单也应说「重新授权」：${JSON.stringify(labels)}`)
  } finally {
    panel.restore()
  }
})

test('授权回调的广播会立刻重拉运行时状态（不等 5 秒轮询）', { skip: skipWithoutBundle() }, async () => {
  /**
   * 授权在**另一个标签页**里完成，面板没办法知道用户什么时候回来 —— 只能等每 5 秒的
   * 轮询。那几秒里卡片停在「需要授权」上，看着就像没生效。
   *
   * 回调页与面板同源，所以回调页广播一声、面板立刻重拉一次就够了。这条测试钉住
   * 「收到了就真的去拉了」——否则那段代码可以一直静默失效而没人发现（它没有可见输出）。
   */
  const panel = await bootPanel(emptyDoc({
    profileServers: [profileServer()], rowOpsReady: true, reconnectReady: true,
    oauthState: { ready: true, reason: '', detail: '', sdkVersion: '2.2.0', redirectUri: 'http://127.0.0.1:3080/cb' },
    oauthServers: { protected: { present: true, refreshable: true, waiting: false, authorizeUrl: '', expiresAt: '', expired: false, at: '' } },
    serverStatus: [statusEntry({ serverName: 'protected', tier: 'global', scope: '', status: 'connected', detail: '' })],
  }))
  try {
    const channel = panel.channels.find((item) => item.name === 'dsh-skills-mcp-manager/oauth')
    assert.ok(channel, '面板必须订阅授权回调的广播频道')
    const before = panel.doc.runtimeFetches ?? 0
    channel.emit('authorized')
    await panel.settle()
    assert.ok((panel.doc.runtimeFetches ?? 0) > before, '收到广播后必须立刻重拉 /runtime')
  } finally {
    panel.restore()
  }
})

test('广播里的其它消息不触发重拉（只有授权完成才算数）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({ profileServers: [profileServer()], rowOpsReady: true }))
  try {
    const channel = panel.channels.find((item) => item.name === 'dsh-skills-mcp-manager/oauth')
    assert.ok(channel)
    const before = panel.doc.runtimeFetches ?? 0
    channel.emit('something-else')
    await panel.settle()
    assert.equal(panel.doc.runtimeFetches ?? 0, before, '无关消息不该让面板重新拉取')
  } finally {
    panel.restore()
  }
})
