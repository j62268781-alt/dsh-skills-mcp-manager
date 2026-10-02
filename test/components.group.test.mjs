/** components/group 接口测试：折叠按钮、标题、副标题与动作区（真实 React）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { groupHead } from '../lib/src/components/group.jsx'

globalThis.__dshReact = React

const Chevron = ({ open }) => React.createElement('span', { className: 'smp-chevron', 'data-open': String(open) })

/** 深度遍历出所有元素节点（按 className 定位，不依赖 children 的索引）。 */
function all(root) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node.props) return
    out.push(node)
    // 不用 React.Children.toArray：它会克隆元素并加 key 前缀，引用相等会失效
    const children = node.props.children
    if (Array.isArray(children)) children.forEach(walk)
    else walk(children)
  }
  walk(root)
  return out
}
const byClass = (root, className) => all(root).find((node) => node.props.className === className)

test('groupHead：返回标题行与副标题两个节点', () => {
  const nodes = groupHead({ Chevron, open: true, onToggle: () => {}, title: '全局 MCP', subText: '全局 · 配置文件 5 个' })
  assert.equal(Array.isArray(nodes), true)
  assert.equal(nodes.length, 2)
  assert.equal(byClass(nodes[0], 'smp-groupTitleRow') !== undefined, true)
  assert.equal(byClass(nodes[1], 'smp-groupSub').props.children, '全局 · 配置文件 5 个')
})

test('groupHead：折叠按钮带 chevron 与标题，点击回调生效', () => {
  let toggles = 0
  const nodes = groupHead({ Chevron, open: false, onToggle: () => { toggles += 1 }, title: '项目级 MCP', subText: 's' })
  const toggle = byClass(nodes[0], 'smp-groupToggle')
  assert.equal(toggle.props.onClick instanceof Function, true)
  assert.equal(byClass(toggle, 'smp-groupTitle').props.children, '项目级 MCP')
  const chevron = all(toggle).find((node) => node.type === Chevron)
  assert.equal(chevron.props.open, false)
  toggle.props.onClick()
  assert.equal(toggles, 1)
})

test('groupHead：动作按钮原样放在标题行内', () => {
  const action = React.createElement('button', { className: 'smp-button', key: 'add' }, '添加服务器')
  const nodes = groupHead({ Chevron, open: true, onToggle: () => {}, title: 't', subText: 's', action })
  assert.equal(all(nodes[0]).includes(action), true)
})
