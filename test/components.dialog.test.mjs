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
  // description 现在是节点（要同时承载说明、失败原因与"删除中"提示）
  const descText = all(node.props.description).map((n) => (typeof n.props.children === 'string' ? n.props.children : '')).join('|')
  assert.match(descText, /会从 cordis.patch.yml 移除该行/)
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

test('删除中：弹窗保持打开、按钮变「删除中…」且禁用，并给出提示', () => {
  const node = deleteConfirmDialog({
    dialog: { label: 'context7', note: '会先备份再删除' },
    primitives, pending: true, error: '', onCancel: () => {}, onConfirm: () => {},
  })
  // description / footer are props, not children: walk them explicitly.
  const hint = all(node.props.description).map((n) => (typeof n.props.children === 'string' ? n.props.children : ''))
  assert.ok(hint.some((t) => t.includes('正在删除并刷新列表')), '应显示删除中的提示')
  const ok = all(node.props.footer).find((n) => typeof n.props.children === 'string' && n.props.children.includes('删除中…'))
  assert.ok(ok, '确认按钮文案应为「删除中…」')
  assert.equal(ok.props.disabled, true, '确认按钮在删除期间必须禁用')
})

test('删除失败：原因显示在弹窗里', () => {
  const node = deleteConfirmDialog({
    dialog: { label: 'ghost', note: 'n' },
    primitives, error: '「ghost」不存在', onCancel: () => {}, onConfirm: () => {},
  })
  const texts = all(node.props.description).map((n) => (typeof n.props.children === 'string' ? n.props.children : '')).join('|')
  assert.match(texts, /「ghost」不存在/, '失败原因要显示出来，而不是静默关闭')
})
