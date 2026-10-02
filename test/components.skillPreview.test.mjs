/** components/skillPreview 接口测试：空值、缺少 primitives、tag 推导与正文渲染。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { skillPreviewDialog } from '../lib/src/components/skillPreview.jsx'

globalThis.__dshReact = React

// 假的 Modal/Button：把 props 原样暴露出来，便于断言
const primitives = {
  Modal: (props) => React.createElement('div', { 'data-modal': 'true' }, props.children),
  Button: (props) => React.createElement('button', props),
}
const skill = { name: 'dart-add-unit-test', description: '为 Dart 加单测', path: '/p/.agents/skills/dart-add-unit-test/SKILL.md', body: '# 正文\n步骤…', source: 'project-agents' }

test('skillPreviewDialog：无技能或缺少 primitives 时返回 null', () => {
  assert.equal(skillPreviewDialog({ skill: null, primitives, onClose() {} }), null)
  assert.equal(skillPreviewDialog({ skill, primitives: undefined, onClose() {} }), null)
})

test('skillPreviewDialog：标题带 agents|dsh tag，描述含描述与文件路径', () => {
  const node = skillPreviewDialog({ skill, primitives, onClose() {} })
  assert.equal(node.props.title, 'dart-add-unit-test（agents）')
  assert.equal(node.props.closeLabel, '关闭')
  assert.match(node.props.description, /为 Dart 加单测/)
  assert.match(node.props.description, /SKILL\.md/)
  assert.equal(typeof node.props.onClose, 'function')
})

test('skillPreviewDialog：dsh 来源推导为 dsh；正文放在 children 里', () => {
  const node = skillPreviewDialog({ skill: { ...skill, source: 'user-dsh' }, primitives, onClose() {} })
  assert.equal(node.props.title, 'dart-add-unit-test（dsh）')
  const pre = node.props.children
  assert.equal(pre.type, 'pre')
  assert.equal(pre.props.className, 'smp-preview')
  assert.match(pre.props.children, /# 正文/)
})

test('skillPreviewDialog：正文缺失时不崩，渲染空串', () => {
  const node = skillPreviewDialog({ skill: { name: 'x', source: 'user-agents' }, primitives, onClose() {} })
  assert.equal(node.props.children.props.children, '')
})
