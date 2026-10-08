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
    // 切到 MCP tab（默认就是），点该行的「编辑」
    panel.click(find((node) => String(node.props.className ?? '').includes('smp-button')
      && textOf(node).trim() === '编辑'))
    assert.ok(byText('保存到配置行') !== null, '没有进入配置行的编辑态')

    // 回填：三个数字来自行配置；command 是原始可执行文件，不是拼好的 target
    const inputs = panel.findAll((node) => node.type === 'input' && node.props.type === 'number')
    const values = inputs.map((node) => node.props.value)
    assert.deepEqual(values, ['1000', '', '60'], `回填的数字不对：${JSON.stringify(values)}`)
    const commandInput = find((node) => node.type === 'input' && node.props.value === 'npx')
    assert.ok(commandInput !== null, 'command 没有回填成原始命令（可能被 target 污染）')

    panel.click(byText('保存到配置行'))
    const op = (doc.rowOps ?? [])[0]
    assert.ok(op, '没有排入 rowOps')
    assert.equal(op.op, 'update')
    assert.equal(op.command, 'npx', '保存时 command 被写成了拼好的 target')
    assert.equal(op.args, '-y pkg')
    assert.equal(op.failOnStartupError, true)
    assert.equal(op.reconnectInitialDelayMs, '1000')
    assert.equal(op.reconnectMaxAttempts, '60')
    assert.equal(op.reconnectMaxDelayMs, '')
    runtime.render()
  } finally {
    panel.restore()
  }
})
