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
  { scope: 'global', id: 'dsh' }, { scope: 'global', id: 'agents' },
  { scope: 'project', id: 'agents' }, { scope: 'project', id: 'dsh' },
]
const walk = (node, found = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) { node.forEach((child) => walk(child, found)); return found }
  found.push(node)
  walk(node.props?.children, found)
  return found
}
const findType = (node, type) => walk(node).find((element) => element.type === type)

test('skillDialogView：空值或缺 primitives 返回 null', () => {
  assert.equal(skillDialogView({ dialog: null, draft: {}, primitives }), null)
  assert.equal(skillDialogView({ dialog: { mode: 'add' }, draft: {}, primitives: undefined }), null)
})

test('skillDialogView：添加态标题/说明/按钮，区域可选且列出四个目标', () => {
  const node = skillDialogView({ dialog: { mode: 'add', regionKey: 'global:dsh' }, draft: { name: '' }, roots, primitives })
  assert.equal(node.props.title, '添加技能')
  assert.match(node.props.description, /自动创建/)
  const select = findType(node, 'select')
  assert.equal(select.props.disabled, false)
  assert.deepEqual(select.props.children.map((option) => option.props.value), ['global:dsh', 'global:agents', 'project:agents', 'project:dsh'])
  assert.deepEqual(select.props.children.map((option) => option.props.children), ['全局 · dsh', '全局 · agents', '项目级 · agents', '项目级 · dsh'])
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
