/**
 * MCP 表单的「连接与重连」分组，真的渲染出来并真的进到行操作里。
 *
 * 纯函数测试（crud.servers）只能证明 draft → op 的映射；这里加载真实的客户端
 * bundle 走一遍交互：打开添加服务器 → 填 4 个字段 → 保存，断言写进设置文档的
 * `rowOps` 里带着这些值。编辑已有配置行时还要断言回填。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle, textOf } from '../scripts/lib/client-harness.mjs'

const PROFILE_ROW = {
  entryId: 'include:mcp-existing', serverName: 'existing', transport: 'stdio',
  target: 'npx -y pkg', command: 'npx', args: '-y pkg', env: 'T=1',
  failOnStartupError: true, reconnectInitialDelayMs: '1000', reconnectMaxDelayMs: '', reconnectMaxAttempts: '60',
  enabled: true, phase: '',
}

/** 打开“添加服务器”并返回面板助手。 */
function openAddForm(panel) {
  panel.click(panel.byClass('smp-button', '添加服务器'))
  return panel
}

test('MCP 表单：渲染「连接与重连」4 个输入并带默认值提示', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc())
  try {
    openAddForm(panel)
    assert.ok(panel.byPlaceholder('500（默认）') !== null, '缺少「重连首次延迟」输入')
    assert.ok(panel.byPlaceholder('30000（默认）') !== null, '缺少「重连最大延迟」输入')
    assert.ok(panel.byPlaceholder('10（默认）') !== null, '缺少「重连最大次数」输入')
    const checkbox = panel.find((node) => node.type === 'input' && node.props.type === 'checkbox')
    assert.ok(checkbox !== null, '缺少 failOnStartupError 勾选框')
    assert.equal(checkbox.props.checked, false, '默认应当是未勾选（DSH 默认 false）')
  } finally {
    panel.restore()
  }
})

test('MCP 表单：填了连接参数后，保存写进 rowOps', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc())
  const { doc, change, byPlaceholder, byText } = panel
  try {
    openAddForm(panel)
    change(byPlaceholder('例如 test，最多 32 字符'), 'github')
    change(byPlaceholder('https://…/mcp'), 'https://example.com/mcp')
    change(byPlaceholder('500（默认）'), '1000')
    change(byPlaceholder('30000（默认）'), '60000')
    change(byPlaceholder('10（默认）'), '60')
    panel.toggle(panel.find((node) => node.type === 'input' && node.props.type === 'checkbox'), true)
    panel.click(byText('保存'))

    const op = (doc.rowOps ?? [])[0]
    assert.ok(op, '保存后没有排入 rowOps')
    assert.equal(op.op, 'add')
    assert.equal(op.serverName, 'github')
    assert.equal(op.failOnStartupError, true)
    assert.equal(op.reconnectInitialDelayMs, '1000')
    assert.equal(op.reconnectMaxDelayMs, '60000')
    assert.equal(op.reconnectMaxAttempts, '60')
  } finally {
    panel.restore()
  }
})

test('MCP 表单：编辑配置行时回填连接参数，且 command 不被 target 污染', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({ profileServers: [PROFILE_ROW], rowOpsReady: true }))
  const { doc, runtime, byText, find } = panel
  try {
    // 切到 MCP tab（默认就是），点该行的「…」→「编辑」
    panel.openMenu()
    panel.click(byText('编辑'))
    assert.ok(byText('保存到配置行') !== null, '没有进入配置行的编辑态')

    // 回填：三个数字来自行配置；command 是原始可执行文件，不是拼好的 target
    const inputs = panel.findAll((node) => node.type === 'input' && node.props.type === 'number')
    const values = inputs.map((node) => node.props.value)
    assert.deepEqual(values, ['1000', '', '60'], `回填的数字不对：${JSON.stringify(values)}`)
    const commandInput = find((node) => node.type === 'input' && node.props.value === 'npx')
    assert.ok(commandInput !== null, 'command 没有回填成原始命令（可能被 target 污染）')

    // 没动过连接输入框 → op 里必须标记 connectionChanged: false（Host 会跳过它们）
    panel.click(byText('保存到配置行'))
    let op = (doc.rowOps ?? [])[0]
    assert.ok(op, '没有排入 rowOps')
    assert.equal(op.op, 'update')
    assert.equal(op.connectionChanged, false, '没改过连接字段却标记成改动，会误删已有配置')
    doc.rowOps = []

    assert.equal(op.command, 'npx', '保存时 command 被写成了拼好的 target')
    assert.equal(op.args, '-y pkg')
    assert.equal(op.failOnStartupError, true)
    assert.equal(op.reconnectInitialDelayMs, '1000')
    assert.equal(op.reconnectMaxAttempts, '60')
    assert.equal(op.reconnectMaxDelayMs, '')

    // 真改了其中一个数字 → 标记成改动，Host 才会写。
    // 保存后该行进入 in-flight（操作按钮被转圈替代），先让回执到达把它落定。
    doc.rowOps = []
    const settled = find((node) => String(node.props.className ?? '').includes('smp-card') && textOf(node).includes('existing'))
    assert.ok(settled !== null, '保存后找不到该行')
    runtime.render()
    panel.openMenu()
    panel.click(byText('编辑'))
    panel.change(panel.byPlaceholder('10（默认）'), '30')
    panel.click(byText('保存到配置行'))
    op = (doc.rowOps ?? [])[0]
    assert.equal(op.connectionChanged, true, '改了连接字段却没标记，值不会生效')
    assert.equal(op.reconnectMaxAttempts, '30')
    runtime.render()
  } finally {
    panel.restore()
  }
})

test('项目级编辑：回填连接字段，并作为**行操作**写入（不再改 config.servers）', { skip: skipWithoutBundle() }, async () => {
  /**
   * 项目级服务器现在也是 `mcp-client` 行，所以编辑走的是与全局完全相同的行操作管线。
   *
   * 这个用例以前断言「编辑后条目不会被挪到 config.servers 末尾」——那是数组原地替换的
   * 顾虑。行操作按 entryId 定位，本来就不会重排，所以真正的契约变成了两条：
   *   1. 表单要回填已配置的连接策略（空值会被当成「用户清空」而写坏）
   *   2. 保存必须产出一条指向该行的 rowOp，而不是去动插件自己的字段
   */
  const projectRow = (entryId, serverName, over = {}) => ({
    entryId, scope: '/p/tcl', serverName, transport: 'streamable-http',
    target: `http://x/mcp/${serverName}`, command: '', args: '', env: '', headersText: '',
    failOnStartupError: false, reconnectInitialDelayMs: '', reconnectMaxDelayMs: '',
    reconnectMaxAttempts: '', enabled: true, phase: 'active', ...over,
  })
  const gitnexus = projectRow('mcp-gitnexus', 'gitnexus', {
    failOnStartupError: true, reconnectInitialDelayMs: '1000', reconnectMaxDelayMs: '60000', reconnectMaxAttempts: '60',
  })
  const figma = projectRow('mcp-framelink-figma', 'framelink-figma')
  const panel = await bootPanel(emptyDoc({
    profileServers: [gitnexus, figma], currentWorkspace: '/p/tcl', rowOpsReady: true,
  }))
  const { doc, findAll, find, byText, change, restore } = panel
  try {
    // 每条都该有「…」触发器（编辑/删除收在里面）。开第一条的菜单再点编辑。
    const triggers = findAll((node) => String(node.props.className ?? '') === 'smp-moreTrigger')
    assert.ok(triggers.length >= 2, `项目级条目没渲染出操作菜单：${triggers.length}`)
    panel.openMenu(0)
    panel.click(byText('编辑'))

    // 回填：必须显示已配置的 1000 / 60000 / 60，而不是空（空会显示成 placeholder 500）
    const numbers = findAll((node) => node.type === 'input' && node.props.type === 'number').map((n) => n.props.value)
    assert.deepEqual(numbers, ['1000', '60000', '60'], `连接字段没回填：${JSON.stringify(numbers)}`)

    change(find((node) => node.type === 'input' && node.props.placeholder === '500（默认）'), '2000')
    // 编辑「行」的表单按钮文案是「保存到配置行」——与全局页签完全一致，因为两档同源
    panel.click(byText('保存到配置行'))

    // 契约：写出一条 rowOp，指向这一行
    const ops = Array.isArray(doc.rowOps) ? doc.rowOps : []
    assert.equal(ops.length, 1, `应恰好排出一条行操作：${JSON.stringify(ops)}`)
    assert.equal(ops[0].op, 'update')
    assert.equal(ops[0].entryId, 'mcp-gitnexus')
    assert.equal(ops[0].reconnectInitialDelayMs, '2000')
    assert.equal(ops[0].reconnectMaxAttempts, '60', '没碰的字段被清空了')
    assert.equal(ops[0].failOnStartupError, true, '没碰的勾选框被清空了')
    // 面板自己的配置字段不再是真相源：两档都只写行
    assert.deepEqual(doc.servers ?? [], [], '不该再往 config.servers 写东西')
  } finally {
    restore()
  }
})
