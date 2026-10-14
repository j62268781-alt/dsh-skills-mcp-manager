/**
 * MCP 单一列表。
 *
 * 这个文件钉住「两档统一成一个列表」这件事，因为它是**有意去掉的区分**，很容易在
 * 后续维护里被无意恢复：
 *   · 只有一份列表，卡片自己说明作用域（全局 / 某个工作区）
 *   · 工具栏不再有「筛选项目」——作用域是服务器的属性，在添加/编辑表单里选
 *   · 「添加服务器」就放在原筛选项目的位置
 *   · 列表同时含全局与项目级，且不重复
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
    assert.ok(t.some((x) => x.includes('MCP 服务器')), `没有统一的列表标题：${JSON.stringify(t.slice(0, 20))}`)
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
    assert.ok(texts(panel).some((x) => x.includes('全局（所有工作区）')), '全局卡片没说明作用域')

    // 再展开项目那张（点第一张会收起它）
    const toggles2 = panel.findAll((node) => String(node.props?.className ?? '').includes('smp-cardToggle'))
    panel.click(toggles2[1])
    assert.ok(texts(panel).some((x) => x.includes('工作区：/p/tcl')), '项目卡片没说明作用域')
  } finally {
    panel.restore()
  }
})

test('MCP：工具栏不再有项目筛选，位置让给「添加服务器」', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    const t = shortTexts(panel)
    assert.ok(t.includes('添加服务器'), `工具栏没有添加按钮：${JSON.stringify(t.slice(0, 24))}`)

    // 只应有一个添加按钮：工具栏那个（分段标题里不再重复一个）
    const addButtons = panel.findAll((node) => (
      String(node.props?.className ?? '').includes('smp-button') && textOf(node).trim() === '添加服务器'))
    assert.equal(addButtons.length, 1, `「添加服务器」应只有 1 个，实际 ${addButtons.length}`)

    // MCP 页签的筛选行里不该出现工作区下拉（技能页签仍保留）
    const scopeLikeSelects = panel.findAll((node) => node.type === 'select'
      && (node.children ?? []).flat(4).some((o) => o?.props?.value === '__custom__'))
    assert.equal(scopeLikeSelects.length, 0, 'MCP 工具栏不该再有项目选择器（它已搬进表单）')
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

    const ops = doc.rowOps ?? []
    assert.equal(ops.length, 1, `应排出一条 rowOp：${JSON.stringify(ops)}`)
    assert.equal(ops[0].scope, '/p/tcl', '作用域必须写进行操作（Host 据此写成 disabled 的项目行）')
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
