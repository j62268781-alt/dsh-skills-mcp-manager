/** components/dialog 接口测试：空闲返回 null，待删时给出官方 Modal 的属性形状。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { deleteConfirmDialog } from '../lib/src/components/dialog.jsx'

globalThis.__dshReact = React

const primitives = { Modal: 'Modal', Button: 'Button' }

/** 深度遍历元素节点（不克隆，保留引用）。 */
function all(root) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node.props) return
    out.push(node)
    const children = node.props.children
    if (Array.isArray(children)) children.forEach(walk)
    else walk(children)
  }
  walk(root)
  return out
}

test('空闲时不渲染', () => {
  assert.equal(deleteConfirmDialog({ dialog: null, primitives }), null)
})

test('没有 primitives 时不渲染（调用方退回 window.confirm）', () => {
  assert.equal(deleteConfirmDialog({ dialog: { label: 'x', note: 'n' }, primitives: null }), null)
})

test('待删时产出官方 Modal：标题/描述/footer 两个按钮', () => {
  const node = deleteConfirmDialog({
    dialog: { label: 'context7', note: '会从 cordis.patch.yml 移除该行' },
    primitives, onCancel: () => {}, onConfirm: () => {},
  })
  assert.equal(node.type, 'Modal')
  assert.equal(node.props.open, true)
  assert.equal(node.props.title, '删除「context7」？')
  assert.equal(node.props.description, '会从 cordis.patch.yml 移除该行')
  assert.equal(node.props.closeLabel, '关闭')
  // footer 是 <>…</>（Fragment 本身也算一个节点），只取官方 Button
  const buttons = all(node.props.footer).filter((n) => n.type === 'Button')
  assert.deepEqual(buttons.map((b) => b.props.variant), ['outline', 'primary'])
  assert.deepEqual(buttons.map((b) => b.props.children), ['取消', '删除'])
})

test('按钮回调原样透传', () => {
  let cancelled = 0
  let confirmed = 0
  const node = deleteConfirmDialog({
    dialog: { label: 'x', note: 'n' }, primitives,
    onCancel: () => { cancelled += 1 }, onConfirm: () => { confirmed += 1 },
  })
  const [cancel, confirm] = all(node.props.footer).filter((n) => n.type === 'Button')
  cancel.props.onClick()
  confirm.props.onClick()
  assert.equal(cancelled, 1)
  assert.equal(confirmed, 1)
})
