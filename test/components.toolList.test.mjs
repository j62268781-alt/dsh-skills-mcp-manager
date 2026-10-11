/**
 * components/toolList 与 card 的工具清单接口测试。
 *
 * 关键约定：三种状态必须可区分 ——
 *   listed（读到了）/ empty（读到但该服务器没有）/ unreadable（注册表读不到）
 * 更进一步：unreadable 还要区分「Host 是旧版本没发布该字段」与「Host 报告了具体失败」。
 * 前者要用户去重启 DSH，后者才是真故障；混在一起会让人去排查一个健康的注册表。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { TOOL_ERROR_REASONS, toolsForServer, toolsSummary } from '../lib/src/components/card.jsx'
import { normalizeDescription, toolListNode } from '../lib/src/components/toolList.jsx'

globalThis.__dshReact = React

const INVENTORY = [
  { serverName: 'context7', tools: [
    { name: 'mcp__context7__resolve-library-id', description: 'Resolves a package name' },
    { name: 'mcp__context7__query-docs', description: '' },
  ] },
  { serverName: 'deepwiki', tools: [] },
]

/** Children with nulls dropped — JSX `{null}` branches still occupy raw props slots,
 * so every structural assertion has to go through this. */
const kids = (node) => React.Children.toArray(node.props.children)

/** Whether the tool heading renders the mode picker. */
function hasModePicker(node) {
  const head = kids(node).find((child) => child?.props?.className === 'smp-toolHead')
  return kids(head).some((child) => child?.props?.className === 'smp-toolModes')
}

/** The mode-picker element, or undefined when it is not rendered. */
function modePicker(node) {
  const head = kids(node).find((child) => child?.props?.className === 'smp-toolHead')
  return kids(head).find((child) => child?.props?.className === 'smp-toolModes')
}

/** The tool rows of a rendered list. */
const rows = (node) => kids(kids(node).find((child) => child?.props?.className === 'smp-toolList'))

/** A editable filter descriptor that records the callbacks it receives. */
function filterHarness(overrides = {}) {
  const calls = { mode: [], toggle: [] }
  return {
    calls,
    filter: {
      mode: 'off',
      tools: [],
      leafOf: (n) => n.replace('mcp__context7__', ''),
      onMode: (m) => calls.mode.push(m),
      onToggle: (leaf, checked) => calls.toggle.push([leaf, checked]),
      ...overrides,
    },
  }
}

test('toolsForServer：读到时给 listed，空清单也算读到', () => {
  const a = toolsForServer(INVENTORY, 'context7')
  assert.equal(a.state, 'listed')
  assert.equal(a.tools.length, 2)

  const empty = toolsForServer(INVENTORY, 'deepwiki')
  assert.equal(empty.state, 'listed')
  assert.deepEqual(empty.tools, [])
})

test('toolsForServer：Host 没发布错误字段 = Host 是旧版本，不是故障', () => {
  // 这条最要紧：旧 Host 不认 serverTools，字段整个缺失；必须提示重启
  const stale = toolsForServer([], 'context7', undefined)
  assert.equal(stale.state, 'unreadable')
  assert.equal(stale.kind, TOOL_ERROR_REASONS.hostStale)
  assert.match(toolsSummary(stale), /需要重启 DSH/)
  // null 同义（未初始化）
  assert.equal(toolsForServer([], 'context7', null).kind, TOOL_ERROR_REASONS.hostStale)
})

test('toolsForServer：字段存在但原因为空 = Host 正常，只是还没发布这个服务器', () => {
  // 这是「当前 Host 读取成功」的信号：不能误判成旧 Host 而让用户去重启
  const absent = toolsForServer([], 'context7', { reason: '', detail: '' })
  assert.equal(absent.state, 'absent')
  const text = toolsSummary(absent)
  assert.doesNotMatch(text, /重启/, '注册表健康时不能提示重启')
  assert.match(text, /尚未发布/)
})

test('toolsForServer：Host 报告了具体原因时如实转达，不冒充重启提示', () => {
  const reported = toolsForServer([], 'context7', { reason: 'service-missing', detail: '' })
  assert.equal(reported.state, 'unreadable')
  assert.equal(reported.kind, TOOL_ERROR_REASONS.reported)
  const text = toolsSummary(reported)
  assert.match(text, /没有工具注册表/)
  assert.doesNotMatch(text, /重启/)
})

test('toolsSummary：四种状态的文案互不相同', () => {
  const listed = toolsSummary(toolsForServer(INVENTORY, 'context7'))
  const empty = toolsSummary(toolsForServer(INVENTORY, 'deepwiki'))
  const stale = toolsSummary(toolsForServer([], 'x', undefined))
  const absent = toolsSummary(toolsForServer([], 'x', { reason: '', detail: '' }))
  const failed = toolsSummary(toolsForServer([], 'x', { reason: 'read-failed', detail: 'boom' }))
  assert.equal(listed, '2 个工具')
  assert.match(empty, /暂无已注册的工具/)
  assert.match(stale, /重启 DSH/)
  assert.match(absent, /尚未发布/)
  assert.match(failed, /读取工具注册表出错/)
  assert.match(failed, /boom/, '带上原始错误，便于排查')
  assert.equal(new Set([listed, empty, stale, absent, failed]).size, 5)
})

test('toolsSummary：未知原因回退到通用文案，不显示 undefined', () => {
  const text = toolsSummary(toolsForServer([], 'x', { reason: 'brand-new-code', detail: '' }))
  assert.equal(text, '工具清单不可读')
})

test('normalizeDescription：压平空白但完整保留文本，不截断', () => {
  assert.equal(normalizeDescription('a\n  b   c'), 'a b c')
  assert.equal(normalizeDescription(undefined), '')
  // 关键：不再按字符数截断——长描述原样带出，由 CSS 折行封顶
  const long = 'x'.repeat(2006)
  assert.equal(normalizeDescription(long), long)
  assert.equal(normalizeDescription(long).length, 2006)
})

test('toolListNode：长描述完整带出，不截断，并提供 title 便于查看全文', () => {
  const long = `Resolves a package name. ${'detail '.repeat(80)}`.trim()
  const node = toolListNode({ state: 'listed', tools: [{ name: 'mcp__s__t', description: long }] })
  const item = rows(node)[0]
  const desc = kids(item).find((c) => c?.props?.className === 'smp-toolDesc')
  // 文本完整（只压过空白），没有被省略号砍掉
  assert.equal(desc.props.children, long.replace(/\s+/g, ' ').trim())
  assert.ok(!desc.props.children.endsWith('…'), '不应再出现截断省略号')
  // 完整文本仍可通过 title 查看
  assert.equal(desc.props.title, desc.props.children)
})

// ---------- 工具过滤（勾选界面） ----------

test('toolListNode：mode=off 时仍是只读列表，但显示模式选择器', () => {
  const { filter } = filterHarness()
  const node = toolListNode(toolsForServer(INVENTORY, 'context7'), 't', filter)
  assert.equal(hasModePicker(node), true, '应出现模式选择器')
  const picker = modePicker(node)
  assert.equal(kids(picker).length, 3, '三个模式按钮')
  assert.equal(kids(picker)[0].props['data-active'], 'true', 'off 是当前项')
  // off 模式下工具名保持完整前缀，且没有勾选框
  const item = rows(node)[0]
  assert.equal(kids(item)[0].props.children, 'mcp__context7__resolve-library-id')
  assert.equal(item.props['data-kept'], undefined)
})

test('toolListNode：mode=allow 时给出勾选框、短名与说明', () => {
  const { filter } = filterHarness({ mode: 'allow', tools: ['resolve-library-id'] })
  const node = toolListNode(toolsForServer(INVENTORY, 'context7'), 't', filter)
  // 选中时多一行说明
  const hint = kids(node).find((k) => k?.props?.className === 'smp-note')
  assert.ok(hint, '应给出勾选说明')
  assert.match(hint.props.children, /1\/2/, '显示已选数量')
  const [first, second] = rows(node)
  // 勾选界面用短名（前缀在每行都相同，重复它会埋掉真正不同的部分）
  const pick = kids(first)[0]
  assert.equal(pick.props.className, 'smp-toolPick')
  const box = kids(pick)[0]
  const name = kids(pick)[1]
  assert.equal(name.props.children, 'resolve-library-id')
  // title 保留完整名字，鼠标悬停可见
  assert.equal(name.props.title, 'mcp__context7__resolve-library-id')
  assert.equal(box.props.checked, true)
  // allow 模式：勾选的就是保留的
  assert.equal(first.props['data-kept'], 'true')
  assert.equal(second.props['data-kept'], 'false')
  assert.equal(kids(kids(second)[0])[0].props.checked, false)
})

test('toolListNode：deny 模式的淡化方向与 allow 相反（勾选=会被挡掉）', () => {
  // 这条防的是一个真实出过的错：淡化若直接跟着勾选状态走，deny 模式会把
  // 「保留下来的工具」淡化，把视觉重点指向恰好相反的行。
  const { filter } = filterHarness({ mode: 'deny', tools: ['resolve-library-id'] })
  const node = toolListNode(toolsForServer(INVENTORY, 'context7'), 't', filter)
  const [picked, unpicked] = rows(node)
  assert.equal(kids(kids(picked)[0])[0].props.checked, true, '勾选了')
  assert.equal(picked.props['data-kept'], 'false', '勾选的会被挡掉 → 淡化')
  assert.equal(unpicked.props['data-kept'], 'true', '没勾的照常注册 → 不淡化')
})

test('toolListNode：点击勾选框把 leaf 与目标状态交给回调', () => {
  const { filter, calls } = filterHarness({ mode: 'allow', tools: [] })
  const node = toolListNode(toolsForServer(INVENTORY, 'context7'), 't', filter)
  const box = kids(kids(rows(node)[0])[0])[0]
  box.props.onChange({ target: { checked: true } })
  assert.deepEqual(calls.toggle, [['resolve-library-id', true]])
})

test('toolListNode：点击模式按钮把目标模式交给回调', () => {
  const { filter, calls } = filterHarness()
  const node = toolListNode(toolsForServer(INVENTORY, 'context7'), 't', filter)
  const buttons = kids(modePicker(node))
  buttons[1].props.onClick()
  buttons[2].props.onClick()
  assert.deepEqual(calls.mode, ['allow', 'deny'])
})

test('toolListNode：没有 onMode（旧 Host）时不渲染选择器，退回只读', () => {
  const node = toolListNode(toolsForServer(INVENTORY, 'context7'), 't', { mode: 'allow', tools: [], leafOf: (n) => n })
  assert.equal(hasModePicker(node), false, '没有 onMode 就不该出现选择器')
  // 也不该出现勾选框
  assert.equal(kids(rows(node)[0])[0].props.className, 'smp-toolName')
})

test('toolListNode：旧 Host 提示重启，而不是笼统的「不可读」', () => {
  const node = toolListNode(toolsForServer([], 'context7', undefined))
  assert.equal(node.props.className, 'smp-toolHead')
  const count = node.props.children[1]
  assert.match(count.props.children, /需要重启 DSH/)
  assert.equal(count.props['data-tone'], 'muted')
})

test('toolListNode：空清单给出可区分的提示', () => {
  const node = toolListNode(toolsForServer(INVENTORY, 'deepwiki'))
  assert.equal(node.props.className, 'smp-toolHead')
  assert.match(node.props.children[1].props.children, /^· 暂无已注册的工具/)
})

test('toolListNode：无 filter 时保持只读列表与完整前缀（向后兼容）', () => {
  const node = toolListNode(toolsForServer(INVENTORY, 'context7'))
  assert.equal(node.props.className, 'smp-tools')
  const head = kids(node)[0]
  // 有清单时标题用括号计数，与「· 原因」形式区分开
  assert.equal(kids(head)[1].props.children, '(2)')
  assert.equal(kids(head)[1].props['data-tone'], undefined)
  // 没有 filter（旧 Host）时不出现模式选择器
  assert.equal(hasModePicker(node), false, '不该出现模式选择器')
  const items = rows(node)
  assert.equal(items.length, 2)
  // 名字是模型要调用的完整名字，读态下不能被缩短
  assert.equal(kids(items[0])[0].props.children, 'mcp__context7__resolve-library-id')
  // 没有描述的工具只渲染名字，描述位不占位
  assert.equal(kids(items[1]).length, 1)
})

test('toolListNode：两种不可读状态都只渲染标题节点（样式挂在标题上）', () => {
  // 分隔线与间距由 .smp-toolHead 提供，否则它们会紧贴字段表、看起来像表格的一部分
  for (const node of [
    toolListNode(toolsForServer([], 'x', undefined)),
    toolListNode(toolsForServer([], 'x', { reason: 'read-failed', detail: '' })),
    toolListNode(toolsForServer([], 'x', { reason: '', detail: '' })),
    toolListNode(toolsForServer(INVENTORY, 'deepwiki')),
  ]) {
    assert.equal(node.props.className, 'smp-toolHead')
  }
})
