/** components/skillDialog 接口测试：空值/缺 primitives、添加与编辑的标题与区域只读。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { skillDialogView } from '../lib/src/components/skillDialog.jsx'

globalThis.__dshReact = React

const primitives = {
  Modal: (props) => React.createElement('div', { 'data-modal': 'true' }, props.children),
  Button: (props) => React.createElement('button', props),
}
const roots = [
  { scope: 'global', id: 'dsh', path: '/h/.dsh/skills' },
  { scope: 'global', id: 'agents', path: '/h/.agents/skills' },
  { scope: 'project', id: 'agents', path: '/p/app/.agents/skills' },
  { scope: 'project', id: 'dsh', path: '/p/app/.dsh/skills' },
]
const walk = (node, found = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) { node.forEach((child) => walk(child, found)); return found }
  found.push(node)
  walk(node.props?.children, found)
  return found
}
const findType = (node, type) => walk(node).find((element) => element.type === type)
const findPlaceholder = (node, placeholder) => walk(node)
  .find((element) => element.props?.placeholder === placeholder)

test('skillDialogView：空值或缺 primitives 返回 null', () => {
  assert.equal(skillDialogView({ dialog: null, draft: {}, primitives }), null)
  assert.equal(skillDialogView({ dialog: { mode: 'add' }, draft: {}, primitives: undefined }), null)
})

test('skillDialogView：添加态列出四个**真实路径**（两个全局根、两个项目根）', () => {
  /**
   * 「全局」不是一个目录而是两个，项目级同理。选项显示绝对路径，选择才是可核对的：
   * 「全局 · agents」并没有告诉用户文件会落在哪。
   */
  const node = skillDialogView({ dialog: { mode: 'add', regionKey: 'global:dsh' }, draft: { name: '' }, roots, primitives })
  assert.equal(node.props.title, '添加技能')
  assert.match(node.props.description, /自动创建/)
  const select = findType(node, 'select')
  assert.equal(select.props.disabled, false)
  assert.deepEqual(select.props.children.map((option) => option.props.value), ['global:dsh', 'global:agents', 'project:agents', 'project:dsh'])
  assert.deepEqual(select.props.children.map((option) => option.props.children), [
    '全局 · /h/.dsh/skills',
    '全局 · /h/.agents/skills',
    '项目级 · /p/app/.agents/skills',
    '项目级 · /p/app/.dsh/skills',
  ])
})

test('skillDialogView：只有项目级才有「工作区」字段，默认带上当前值', () => {
  // 选到用户级根时问工作区是没有效果的字段；选到项目级根时它决定写到哪个工作区。
  const global = skillDialogView({ dialog: { mode: 'add', regionKey: 'global:dsh' }, draft: {}, roots, primitives })
  assert.equal(findPlaceholder(global, '/绝对路径'), undefined, '全局区域不该问工作区')

  const node = skillDialogView({
    dialog: { mode: 'add', regionKey: 'project:agents', project: '/p/app' }, draft: {}, roots,
    workspaceChoices: [['/p/app', 'App'], ['/p/other', 'Other']], primitives,
  })
  const input = findPlaceholder(node, '/绝对路径')
  assert.ok(input !== undefined, '项目级区域必须有工作区字段')
  assert.equal(input.props.value, '/p/app')
  const datalist = findType(node, 'datalist')
  assert.deepEqual(datalist.props.children.map((option) => option.props.value), ['/p/app', '/p/other'])
})

test('skillDialogView：编辑态不显示工作区字段（区域只读，工作区随之固定）', () => {
  const node = skillDialogView({
    dialog: { mode: 'edit', regionKey: 'project:agents', project: '/p/app', prevName: 'alpha' },
    draft: { name: 'alpha' }, roots, primitives,
  })
  assert.equal(findPlaceholder(node, '/绝对路径'), undefined)
})

test('skillDialogView：编辑态区域只读、标题带原名、提示备份', () => {
  const node = skillDialogView({ dialog: { mode: 'edit', regionKey: 'global:agents', prevName: 'alpha' }, draft: { name: 'alpha' }, roots, primitives })
  assert.equal(node.props.title, '编辑技能「alpha」')
  assert.match(node.props.description, /区域不可修改/)
  assert.match(node.props.description, /备份/)
  assert.equal(findType(node, 'select').props.disabled, true)
})

test('skillDialogView：错误显示、pending 时保存禁用', () => {
  const node = skillDialogView({ dialog: { mode: 'add', regionKey: 'global:dsh' }, draft: {}, roots, primitives, error: '名字已存在', pending: true })
  assert.match(JSON.stringify(node.props.children), /名字已存在/)
  const save = walk(node.props.footer).find((element) => element.key === 'save')
  assert.equal(save.props.disabled, true)
})
