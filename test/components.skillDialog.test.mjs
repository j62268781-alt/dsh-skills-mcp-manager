/**
 * components/skillDialog 接口测试。
 *
 * 目标是**三个正交选择**（层级 / 工作区 / 目录）+ 一行解析后的绝对路径，而不是一个平铺
 * 四个根的「区域」下拉：后者把三个不同的问题混在一起，而且每多一个工作区就多一个选项。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { skillDialogView } from '../lib/src/components/skillDialog.jsx'

globalThis.__dshReact = React

const primitives = {
  Modal: (props) => React.createElement('div', { 'data-modal': 'true' }, props.children),
  Button: (props) => React.createElement('button', props),
}
const choices = [['/p/app', 'App'], ['/p/other', 'Other']]
const walk = (node, found = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) { node.forEach((child) => walk(child, found)); return found }
  found.push(node)
  walk(node.props?.children, found)
  return found
}
/** Every node whose className contains the given token. */
const allByClass = (node, token) => walk(node)
  .filter((element) => String(element.props?.className ?? '').split(/\s+/).includes(token))
/**
 * The `.smp-field` whose `.smp-label` text is `label`.
 *
 * `field()` 把标签放在 `<span className="smp-label">` 里，不是 label 的直接文本子节点 ——
 * 所以按「文本恰好等于」去找会找不到。这里按 label span 的内容匹配。
 */
const fieldByLabel = (node, label) => walk(node)
  .filter((element) => String(element.props?.className ?? '').split(/\s+/).includes('smp-field'))
  .find((element) => walk(element)
    .some((child) => String(child.props?.className ?? '') === 'smp-label' && child.props?.children === label))
/** Options of one labelled select, as `[value, text]` pairs. */
const optionsOf = (node, label) => {
  const field = fieldByLabel(node, label)
  assert.ok(field !== undefined, `找不到「${label}」字段`)
  const select = walk(field).find((element) => element.type === 'select')
  assert.ok(select !== undefined, `「${label}」里没有 select`)
  // `{choices.map(...)}` 是一个**嵌套数组**（JSX 允许，React 会摊平），所以这里也摊平 ——
  // 直接对 children 取 .props 会拿到 undefined，那是测试的读法问题，不是组件的问题。
  return select.props.children
    .flat(Infinity)
    .filter((option) => option !== null && option !== undefined)
    .map((option) => [option.props.value, option.props.children])
}
const inputIn = (node, label) => {
  const field = fieldByLabel(node, label)
  return field === undefined ? undefined : walk(field).find((element) => element.type === 'input')
}

test('skillDialogView：空值或缺 primitives 返回 null', () => {
  assert.equal(skillDialogView({ dialog: null, draft: {}, primitives }), null)
  assert.equal(skillDialogView({ dialog: { mode: 'add' }, draft: {}, primitives: undefined }), null)
})

test('skillDialogView：层级只有「全局 / 项目级」两个选项', () => {
  const node = skillDialogView({
    dialog: { mode: 'add', scope: 'global', id: 'dsh' }, draft: {}, primitives,
  })
  assert.equal(node.props.title, '添加技能')
  assert.match(node.props.description, /自动创建/)
  assert.deepEqual(optionsOf(node, '层级'), [
    ['global', '全局 —— 所有工作区都能用'],
    ['project', '项目级 —— 只在某个工作区'],
  ])
})

test('skillDialogView：目录只有 .dsh/skills 与 .agents/skills', () => {
  const node = skillDialogView({
    dialog: { mode: 'add', scope: 'global', id: 'dsh' }, draft: {}, primitives,
  })
  assert.deepEqual(optionsOf(node, '目录'), [['dsh', '.dsh/skills'], ['agents', '.agents/skills']])
})

test('skillDialogView：全局时不显示工作区；项目级才显示，且带注册表选项与自定义路径', () => {
  const global = skillDialogView({
    dialog: { mode: 'add', scope: 'global', id: 'dsh' }, draft: {}, primitives,
    workspaceChoices: choices,
  })
  // 用户级根问工作区是没有效果的字段
  assert.equal(fieldByLabel(global, '工作区'), undefined, '全局不该问工作区')

  const project = skillDialogView({
    dialog: { mode: 'add', scope: 'project', id: 'agents', project: '/p/app' }, draft: {}, primitives,
    workspaceChoices: choices,
  })
  assert.deepEqual(optionsOf(project, '工作区'), [
    ['', '请选择工作区'],
    ['/p/app', 'App'],
    ['/p/other', 'Other'],
    ['__custom__', '自定义路径…'],
  ])
  // 未选自定义时是下拉，没有自由输入框
  assert.equal(inputIn(project, '工作区'), undefined, '非自定义模式不该有输入框')
})

test('skillDialogView：自定义路径模式变成输入框，并回显已填的值', () => {
  const node = skillDialogView({
    dialog: { mode: 'add', scope: 'project', id: 'agents', project: '/p/typed', projectCustom: true },
    draft: {}, primitives, workspaceChoices: choices,
  })
  const select = walk(fieldByLabel(node, '工作区')).find((element) => element.type === 'select')
  assert.equal(select.props.value, '__custom__', '下拉应停在「自定义路径…」')
  const input = inputIn(node, '工作区')
  assert.ok(input !== undefined, '自定义模式必须有输入框')
  assert.equal(input.props.value, '/p/typed')
  assert.equal(input.props.placeholder, '工作区绝对路径')
})

test('skillDialogView：显示解析后的真实落盘路径（三选一的结果，不是让用户推断）', () => {
  const globalDsh = skillDialogView({
    dialog: { mode: 'add', scope: 'global', id: 'dsh' }, draft: {}, primitives,
    resolvedPath: '/h/.dsh/skills',
  })
  assert.match(JSON.stringify(globalDsh.props.children), /将写入 \/h\/\.dsh\/skills\/<名字>\/SKILL\.md/)

  const globalAgents = skillDialogView({
    dialog: { mode: 'add', scope: 'global', id: 'agents' }, draft: {}, primitives,
    resolvedPath: '/h/.agents/skills',
  })
  assert.match(JSON.stringify(globalAgents.props.children), /\.agents\/skills/)

  // 项目级没选工作区时没有可解析的目标 —— 这一行不该出现（否则是猜的）
  const unresolved = skillDialogView({
    dialog: { mode: 'add', scope: 'project', id: 'agents', project: '' }, draft: {}, primitives,
    resolvedPath: '',
  })
  assert.doesNotMatch(JSON.stringify(unresolved.props.children), /将写入/)
})

test('skillDialogView：编辑态三个选择都只读，标题带原名并提示备份', () => {
  const node = skillDialogView({
    dialog: { mode: 'edit', scope: 'project', id: 'agents', project: '/p/app', prevName: 'alpha' },
    draft: { name: 'alpha' }, primitives, resolvedPath: '/p/app/.agents/skills',
  })
  assert.equal(node.props.title, '编辑技能「alpha」')
  assert.match(node.props.description, /不可修改/)
  assert.match(node.props.description, /备份/)
  for (const label of ['层级', '工作区', '目录']) {
    const select = walk(fieldByLabel(node, label)).find((element) => element.type === 'select')
    assert.equal(select.props.disabled, true, `编辑态「${label}」应当只读`)
  }
})

test('skillDialogView：错误显示、pending 时保存禁用', () => {
  const node = skillDialogView({
    dialog: { mode: 'add', scope: 'global', id: 'dsh' }, draft: {}, primitives,
    error: '名字已存在', pending: true,
  })
  assert.match(JSON.stringify(node.props.children), /名字已存在/)
  const save = walk(node.props.footer).find((element) => element.key === 'save')
  assert.equal(save.props.disabled, true)
})
