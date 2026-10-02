/** components/dialog 接口测试：空闲返回 null，待删时给出官方 Modal 的属性形状。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deleteConfirmDialog } from '../lib/src/components/dialog.js'

/** 最小 createElement 替身：把调用记录成 { type, props, children }。 */
function makeH() {
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  h.Fragment = Symbol('Fragment')
  return h
}
const primitives = { Modal: 'Modal', Button: 'Button' }

test('空闲时不渲染', () => {
  assert.equal(deleteConfirmDialog({ dialog: null, primitives, h: makeH() }), null)
})

test('没有 primitives 时不渲染（调用方退回 window.confirm）', () => {
  assert.equal(deleteConfirmDialog({ dialog: { label: 'x', note: 'n' }, primitives: null, h: makeH() }), null)
})

test('待删时产出官方 Modal：标题/描述/footer 两个按钮', () => {
  const calls = []
  const h = makeH()
  const wrapped = (type, props, ...rest) => { const node = h(type, props, ...rest); calls.push(node); return node }
  wrapped.Fragment = h.Fragment
  const node = deleteConfirmDialog({
    dialog: { label: 'context7', note: '会从 cordis.patch.yml 移除该行' },
    primitives, h: wrapped, onCancel: () => {}, onConfirm: () => {},
  })
  assert.equal(node.type, 'Modal')
  assert.equal(node.props.open, true)
  assert.equal(node.props.title, '删除「context7」？')
  assert.equal(node.props.description, '会从 cordis.patch.yml 移除该行')
  assert.equal(node.props.closeLabel, '关闭')
  // 假 createElement 不扁平化数组子元素（React 会），所以取 [0]
  const [cancel, confirm] = node.props.footer.children[0]
  assert.equal(cancel.props.variant, 'outline')
  assert.equal(cancel.children[0], '取消')
  assert.equal(confirm.props.variant, 'primary')
  assert.equal(confirm.children[0], '删除')
})

test('按钮回调原样透传', () => {
  const h = makeH()
  let cancelled = 0
  let confirmed = 0
  const node = deleteConfirmDialog({
    dialog: { label: 'x', note: 'n' }, primitives, h,
    onCancel: () => { cancelled += 1 }, onConfirm: () => { confirmed += 1 },
  })
  const [cancel, confirm] = node.props.footer.children[0]
  cancel.props.onClick(); confirm.props.onClick()
  assert.equal(cancelled, 1)
  assert.equal(confirmed, 1)
})
