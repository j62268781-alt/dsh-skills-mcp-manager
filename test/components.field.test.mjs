/** components/field 接口测试：标签、控件、宽字段标记。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { field } from '../lib/src/components/field.jsx'

globalThis.__dshReact = React

test('field：包住标签与控件，key 用 label', () => {
  const control = React.createElement('input', { className: 'smp-input', key: 'i' })
  const node = field('名称', control)
  assert.equal(node.type, 'label')
  assert.equal(node.props.className, 'smp-field')
  assert.equal(node.key, '名称')
  assert.equal(node.props['data-wide'], false)
  // 用原始 children：React.Children.toArray 会克隆元素，引用相等会失效
  const kids = node.props.children
  assert.equal(kids[0].props.className, 'smp-label')
  assert.equal(kids[0].props.children, '名称')
  assert.equal(kids[1], control)
})

test('field：wide 时 data-wide 为 true', () => {
  assert.equal(field('x', null, true).props['data-wide'], true)
  assert.equal(field('x', null).props['data-wide'], false)
})
