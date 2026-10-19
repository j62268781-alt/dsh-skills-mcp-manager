/**
 * MCP 单一列表。
 *
 * 这个文件钉住「两档统一成一个列表」这件事，因为它是**有意去掉的区分**，很容易在
 * 后续维护里被无意恢复：
 *   · 只有一份列表，卡片自己说明作用域（全局 / 某个工作区）
 *   · 工具栏不再有「筛选项目」——作用域是服务器的属性，在添加/编辑表单里选
 *   · 「添加服务器」在**导入卡片下方**，不在工具栏、也不在列表末尾
 *     （工具栏按钮配上列表底部的表单，会让「点了没反应，还要往下滚」）
 *   · 列表同时含全局与项目级，且不重复
 *   · 顺序为 全局 → 工作区（按工作区顺序），组内保持创建顺序
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle, textOf } from '../scripts/lib/client-harness.mjs'

const row = (entryId, serverName, scope, target = `https://${serverName}.invalid/mcp`) => ({
  entryId, serverName, scope, transport: 'streamable-http', target,
  command: '', args: '', env: '', headersText: '', failOnStartupError: false,
  reconnectInitialDelayMs: '', reconnectMaxDelayMs: '', reconnectMaxAttempts: '',
  enabled: true, phase: 'active',
})

const GLOBAL_ROW = row('mcp-context7', 'context7', '')
const PROJECT_ROW = row('mcp-gitnexus', 'gitnexus', '/p/tcl', 'http://x/mcp/coding')

const boot = (over = {}) => bootPanel(emptyDoc({
  profileServers: [GLOBAL_ROW, PROJECT_ROW],
  workspaces: [{ path: '/p/tcl', title: 'TCL 极光' }],
  currentWorkspace: '/p/tcl',
  rowOpsReady: true,
  reconnectReady: true,
  ...over,
}))

/** Every short text node, for presence/absence assertions. */
const texts = (panel) => panel
  .findAll((node) => typeof node.children?.[0] === 'string')
  .map((node) => node.children[0])

const shortTexts = (panel) => texts(panel).filter((t) => t.length < 70)

test('MCP：全局与项目级在同一个列表里，不再分两个区块', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    const t = shortTexts(panel)
    // No section heading any more: the list follows the import card directly, and the
    // summary line lives above the search box.
    assert.ok(!t.some((x) => x.includes('MCP 服务器')), `不该再有区块标题：${JSON.stringify(t.slice(0, 20))}`)
    assert.ok(!t.includes('全局 MCP'), '不该再有「全局 MCP」这个分区')
    assert.ok(!t.includes('项目级 MCP'), '不该再有「项目级 MCP」这个分区')
    // 两档都在同一列表里
    assert.ok(t.includes('context7'), '全局服务器没出现')
    assert.ok(t.includes('gitnexus'), '项目级服务器没出现')
  } finally {
    panel.restore()
  }
})

test('MCP：卡片自己说明作用域（全局 / 工作区路径）', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    const toggles = panel.findAll((node) => String(node.props?.className ?? '').includes('smp-cardToggle'))
    assert.equal(toggles.length, 2, `应有 2 张卡片，实际 ${toggles.length}`)

    // 展开全局那张
    panel.click(toggles[0])
    // 值只写「全局」：键已经是「作用域」，值里再带「（所有工作区）」是同义反复。
    assert.ok(texts(panel).some((x) => x === '全局'), '全局卡片没说明作用域')

    // 再展开项目那张（点第一张会收起它）
    const toggles2 = panel.findAll((node) => String(node.props?.className ?? '').includes('smp-cardToggle'))
    panel.click(toggles2[1])
    assert.ok(texts(panel).some((x) => x === '/p/tcl'), '项目卡片没说明作用域（应直接给路径）')
    /**
     * 只钉「详情值里」不再出现「工作区」——不能对整个面板断言，因为导入卡片的
     * 「选工作区」、表单里的「作用域（哪个工作区可用）」都是**解释性**文案，那里
     * 说清「工作区」是必要的，删掉反而更难懂。
     */
    const detailValues = panel.findAll((node) => String(node.props.className ?? '') === 'smp-detailsValue')
    for (const node of detailValues) {
      assert.equal(textOf(node).includes('工作区'), false, `详情值里不该出现「工作区」：${textOf(node)}`)
    }
  } finally {
    panel.restore()
  }
})

test('MCP：工具栏不再有项目筛选，位置让给「添加服务器」', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    const t = shortTexts(panel)
    assert.ok(t.includes('添加服务器'), `工具栏没有添加按钮：${JSON.stringify(t.slice(0, 24))}`)

    // 只应有一个添加按钮：搜索行那个（列表附近不再重复一个）
    const addButtons = panel.findAll((node) => (
      String(node.props?.className ?? '').includes('smp-button') && textOf(node).trim() === '添加服务器'))
    assert.equal(addButtons.length, 1, `「添加服务器」应只有 1 个，实际 ${addButtons.length}`)

    // 它与搜索框同一行（`smp-filterRow`），不是一个独立的一行按钮。
    const toolbar = panel.find((node) => String(node.props?.className ?? '') === 'smp-filterRow')
    assert.ok(toolbar !== null, '找不到工具栏')
    assert.ok(textOf(toolbar).includes('添加服务器'), '添加按钮应与搜索框同一行')

    // MCP 页签的筛选行里不该出现工作区下拉（技能页签仍保留）
    const scopeLikeSelects = panel.findAll((node) => node.type === 'select'
      && (node.children ?? []).flat(4).some((o) => o?.props?.value === '__custom__'))
    assert.equal(scopeLikeSelects.length, 0, 'MCP 工具栏不该再有项目选择器（它已搬进表单）')
  } finally {
    panel.restore()
  }
})

test('MCP：添加表单位于导入卡片下方、列表上方（不是列表末尾）', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    // 渲染顺序：导入卡片 → 服务器列表。
    const dump = []
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (node === null || node === undefined || typeof node !== 'object' || node.element !== true) return
      const tokens = String(node.props?.className ?? '').split(/\s+/)
      if (tokens.includes('smp-cards')) dump.push(node.key)
      if (typeof node.type === 'function') { walk(node.type({ ...node.props, children: node.children })); return }
      walk(node.children)
    }
    walk(panel.runtime.tree)
    assert.deepEqual(dump, ['import', 'cards'], `未打开表单时顺序不对：${JSON.stringify(dump)}`)

    const add = panel.findAll((node) => (
      String(node.props?.className ?? '').includes('smp-button') && textOf(node).trim() === '添加服务器'))
    panel.click(add[0])

    const after = []
    const walk2 = (node) => {
      if (Array.isArray(node)) { node.forEach(walk2); return }
      if (node === null || node === undefined || typeof node !== 'object' || node.element !== true) return
      const tokens = String(node.props?.className ?? '').split(/\s+/)
      if (tokens.includes('smp-cards')) after.push(node.key)
      if (typeof node.type === 'function') { walk2(node.type({ ...node.props, children: node.children })); return }
      walk2(node.children)
    }
    walk2(panel.runtime.tree)
    assert.deepEqual(after, ['import', 'formWrap', 'cards'],
      `表单应夹在导入卡片与列表之间，而不是列表末尾：${JSON.stringify(after)}`)
  } finally {
    panel.restore()
  }
})

test('MCP：列表顺序为 全局 → 工作区（按工作区顺序），组内保持创建顺序', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({
    profileServers: [
      row('mcp-context7', 'context7', ''),
      // 配置文件里 other 排在 gitnexus 之前，但工作区顺序是 tcl 在前
      row('mcp-other', 'other', '/p/other'),
      row('mcp-gitnexus', 'gitnexus', '/p/tcl'),
      row('mcp-newest', 'newest', '/p/tcl'),
    ],
    workspaces: [{ path: '/p/tcl', title: 'TCL' }, { path: '/p/other', title: 'OTHER' }],
    currentWorkspace: '/p/tcl',
    rowOpsReady: true,
    reconnectReady: true,
  }))
  try {
    const order = panel.findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-cardToggle'))
      .map((node) => textOf(node).replace(/\s+/g, ' ').trim())
    // 全局第一；tcl 组在 other 组之前；组内 newest 在 gitnexus 之后（= 新增排最后）
    const seen = order.join(' | ')
    assert.ok(seen.startsWith('context7'), `全局应排第一：${seen}`)
    assert.ok(seen.indexOf('gitnexus') < seen.indexOf('other'), `tcl 组应在 other 组之前：${seen}`)
    assert.ok(seen.indexOf('gitnexus') < seen.indexOf('newest'), `组内应保持创建顺序：${seen}`)
  } finally {
    panel.restore()
  }
})

test('MCP：添加表单带作用域选择（原项目筛选的功能搬到这里）', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    const add = panel.findAll((node) => (
      String(node.props?.className ?? '').includes('smp-button') && textOf(node).trim() === '添加服务器'))
    panel.click(add[0])

    assert.ok(texts(panel).some((x) => String(x).includes('作用域（')), '表单里没有作用域字段')

    const scopeSelect = panel.findAll((node) => node.type === 'select'
      && (node.children ?? []).flat(4).some((o) => o?.props?.value === '__custom__'))
    assert.equal(scopeSelect.length, 1, '表单里应有且仅有一个作用域下拉')

    const values = (scopeSelect[0].children ?? []).flat(4).filter(Boolean).map((o) => o.props?.value)
    assert.deepEqual(values, ['global', '/p/tcl', '__custom__'],
      '作用域选项应为：全局 + 已知工作区 + 自定义路径')
  } finally {
    panel.restore()
  }
})

test('MCP：表单里选项目作用域后保存，rowOp 带上该 scope', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot({ profileServers: [] })
  const { doc, findAll, find, byText, change, restore } = panel
  try {
    const add = findAll((node) => (
      String(node.props?.className ?? '').includes('smp-button') && textOf(node).trim() === '添加服务器'))
    panel.click(add[0])
    change(find((node) => node.type === 'input' && String(node.props?.placeholder ?? '').includes('例如 test')), 'proj-new')
    change(find((node) => node.type === 'input' && String(node.props?.placeholder ?? '').includes('https://')), 'http://x/mcp/new')

    const scopeSelect = findAll((node) => node.type === 'select'
      && (node.children ?? []).flat(4).some((o) => o?.props?.value === '__custom__'))[0]
    panel.change(scopeSelect, '/p/tcl')
    panel.click(byText('保存'))

    await panel.settle()
    const ops = doc.rowCommands ?? []
    assert.equal(ops.length, 1, `应发出一条命令：${JSON.stringify(ops)}`)
    assert.equal(ops[0].scope, '/p/tcl', '作用域必须写进命令（Host 据此写成 disabled 的项目行）')
    assert.equal(ops[0].scopeChanged, true)
  } finally {
    restore()
  }
})

test('MCP：页签计数是列表里服务器的数量', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    assert.ok(shortTexts(panel).includes('MCP（2）'),
      `计数应为 2，实际：${JSON.stringify(shortTexts(panel).filter((t) => t.startsWith('MCP（')))}`)
  } finally {
    panel.restore()
  }
})

test('MCP：`…` 菜单里始终有「授权」入口（OAuth 可用且是 http 传输时）', { skip: skipWithoutBundle() }, async () => {
  /**
   * 授权入口必须在**菜单**里，而不是只在「需要授权」那张卡的状态注记里。
   *
   * 状态注记是按当前状态条件渲染的：一旦这台服务器被判成别的状态（或用户想换账号重新
   * 授权），入口就消失了。菜单是「对这台服务器能做什么」的固定清单，授权属于那一类。
   */
  const withOauth = {
    profileServers: [{
      entryId: 'include:mcp-gitnexus', serverName: 'gitnexus', scope: 'global',
      transport: 'streamable-http', target: 'http://sz-00575123-01/mcp/coding',
      command: '', args: '', env: '', headersText: '', failOnStartupError: false,
      reconnectInitialDelayMs: '', reconnectMaxDelayMs: '', reconnectMaxAttempts: '',
      toolCallTimeoutMs: '', enabled: true, phase: '',
    }],
    oauthState: { ready: true, reason: '', detail: '', sdkVersion: '2.2.0', redirectUri: 'http://127.0.0.1:1/cb' },
    oauthServers: { gitnexus: { present: false, refreshable: false, waiting: false, authorizeUrl: '', expiresAt: '', expired: false, at: '' } },
  }
  const panel = await bootPanel(emptyDoc(withOauth))
  try {
    const menu = panel.openMenu(0)
    assert.ok(menu !== null, '没打开卡片菜单')
    const labels = panel.findAll((node) => String(node.props.className ?? '') === 'smp-menuItem').map((node) => textOf(node).trim())
    assert.ok(labels.includes('授权'), `菜单里缺少「授权」：${JSON.stringify(labels)}`)
    // 已有凭据时应当说「重新授权」，否则用户不知道自己是在覆盖一份可用凭据。
    assert.equal(labels.includes('重新授权'), false, '没有凭据时不该说「重新授权」')
  } finally {
    panel.restore()
  }
})

test('MCP：OAuth 不可用时菜单里**没有**「授权」（假按钮比没有更糟）', { skip: skipWithoutBundle() }, async () => {
  const noOauth = {
    profileServers: [{
      entryId: 'include:mcp-gitnexus', serverName: 'gitnexus', scope: 'global',
      transport: 'streamable-http', target: 'http://sz-00575123-01/mcp/coding',
      command: '', args: '', env: '', headersText: '', failOnStartupError: false,
      reconnectInitialDelayMs: '', reconnectMaxDelayMs: '', reconnectMaxAttempts: '',
      toolCallTimeoutMs: '', enabled: true, phase: '',
    }],
    oauthState: { ready: false, reason: 'sdk-missing', detail: '找不到 SDK', sdkVersion: '', redirectUri: '' },
  }
  const panel = await bootPanel(emptyDoc(noOauth))
  try {
    panel.openMenu(0)
    const labels = panel.findAll((node) => String(node.props.className ?? '') === 'smp-menuItem').map((node) => textOf(node).trim())
    assert.equal(labels.includes('授权'), false, `OAuth 不可用时不该有「授权」：${JSON.stringify(labels)}`)
  } finally {
    panel.restore()
  }
})

test('MCP：已连接且凭据有效时，菜单里**不**出现「重新授权」', { skip: skipWithoutBundle() }, async () => {
  /**
   * 「重新授权」不是永远有用的：已连接 + 凭据有效就证明这套凭据能用，此时把「替换凭据」
   * 摆在手边只会让菜单变长，而它是个会动凭据的动作。
   *
   * 但它也没有因此失去入口 —— 服务器一旦没连上（或还没凭据），它就该回来。
   */
  const rowOf = {
    entryId: 'include:mcp-gitnexus', serverName: 'gitnexus', scope: 'global',
    transport: 'streamable-http', target: 'http://sz-00575123-01/mcp/coding',
    command: '', args: '', env: '', headersText: '', failOnStartupError: false,
    reconnectInitialDelayMs: '', reconnectMaxDelayMs: '', reconnectMaxAttempts: '',
    toolCallTimeoutMs: '', enabled: true, phase: '',
  }
  const doc = (status) => ({
    profileServers: [rowOf],
    oauthState: { ready: true, reason: '', detail: '', sdkVersion: '2.2.0', redirectUri: 'http://127.0.0.1:1/cb' },
    oauthServers: { gitnexus: { present: true, refreshable: true, waiting: false, authorizeUrl: '', expiresAt: '', expired: false, at: '' } },
    serverStatus: [{ serverName: 'gitnexus', tier: 'global', scope: '', status, detail: '' }],
  })

  const connected = await bootPanel(emptyDoc(doc('connected')))
  try {
    connected.openMenu(0)
    const labels = connected.findAll((node) => String(node.props.className ?? '') === 'smp-menuItem').map((node) => textOf(node).trim())
    assert.equal(labels.includes('重新授权'), false, `已连接时不该出现「重新授权」：${JSON.stringify(labels)}`)
  } finally {
    connected.restore()
  }

  // 有凭据但没连上：这时它才是排障入口，必须回来
  const broken = await bootPanel(emptyDoc(doc('gave-up')))
  try {
    broken.openMenu(0)
    const labels = broken.findAll((node) => String(node.props.className ?? '') === 'smp-menuItem').map((node) => textOf(node).trim())
    assert.ok(labels.includes('重新授权'), `没连上时「重新授权」必须可用：${JSON.stringify(labels)}`)
  } finally {
    broken.restore()
  }
})

test('MCP 列表以 /runtime 为准：settings 文档滞后时仍然显示新行', { skip: skipWithoutBundle() }, async () => {
  /**
   * 真机问题：Host 已经写好投影，面板却要**重开设置页**才看见新服务器。
   *
   * 根因在 settings 文档那条路上的镜像缓存（`ConfigForm` → settings describe 镜像），
   * 那是框架层、我们观察不到。所以列表改以 `/runtime` 为准 —— 它是每次请求现算的普通
   * HTTP 应答，没有中间缓存，面板本来就在轮询它。
   *
   * 这条模拟两边不一致：settings 文档还是旧的两条，`/runtime` 已经是三条。
   */
  const row = (name, scope = 'global') => ({
    entryId: `include:mcp-${name}`, serverName: name, scope,
    transport: 'streamable-http', target: `https://${name}.invalid/mcp`,
    command: '', args: '', env: '', headersText: '', failOnStartupError: false,
    reconnectInitialDelayMs: '', reconnectMaxDelayMs: '', reconnectMaxAttempts: '',
    toolCallTimeoutMs: '', enabled: true, phase: 'active',
  })
  const panel = await bootPanel(emptyDoc({
    // settings 文档：滞后的旧值
    profileServers: [row('context7'), row('deepwiki')],
    // /runtime：Host 现算的真相
    runtimeServers: [row('context7'), row('deepwiki'), row('gitnexus')],
    rowOpsReady: true, reconnectReady: true,
  }))
  try {
    // `smp-cardIdentity` 也用在「导入 MCP」那张卡上，所以按服务器名做前缀匹配。
    const names = panel.findAll((node) => String(node.props.className ?? '') === 'smp-cardIdentity')
      .map((node) => textOf(node).trim())
      .filter((text) => text !== '导入 MCP')
    assert.equal(names.length, 3, `列表应以 /runtime 为准显示 3 台：${JSON.stringify(names)}`)
    assert.ok(names.some((text) => text.startsWith('gitnexus')), `新加的那台必须出现：${JSON.stringify(names)}`)
  } finally {
    panel.restore()
  }
})

test('MCP 列表：老 Host 的 /runtime 不带 servers 时回落到 settings 投影', { skip: skipWithoutBundle() }, async () => {
  // 两条路都要在：新版 Host 走 runtime，旧版 Host（没有这个字段）仍然能用。
  const panel = await bootPanel(emptyDoc({
    profileServers: [{
      entryId: 'include:mcp-context7', serverName: 'context7', scope: 'global',
      transport: 'streamable-http', target: 'https://mcp.context7.com/mcp',
      command: '', args: '', env: '', headersText: '', failOnStartupError: false,
      reconnectInitialDelayMs: '', reconnectMaxDelayMs: '', reconnectMaxAttempts: '',
      toolCallTimeoutMs: '', enabled: true, phase: 'active',
    }],
    runtimeServers: [], rowOpsReady: true, reconnectReady: true,
  }))
  try {
    const names = panel.findAll((node) => String(node.props.className ?? '') === 'smp-cardIdentity')
      .map((node) => textOf(node).trim())
    assert.ok(names.some((text) => text.startsWith('context7')), `没有 servers 字段时要回落到投影：${JSON.stringify(names)}`)
  } finally {
    panel.restore()
  }
})
