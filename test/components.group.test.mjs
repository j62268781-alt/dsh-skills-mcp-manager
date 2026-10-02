/** components/group 接口测试：折叠按钮、标题、副标题与动作区。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupHead } from '../lib/src/components/group.js'

const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
const Chevron = (props) => ({ type: 'Chevron', props })

test('groupHead：返回标题行与副标题两个节点', () => {
  const nodes = groupHead({ h, Chevron, open: true, onToggle: () => {}, title: '全局 MCP', subText: '全局 · 配置文件 5 个' })
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].props.className, 'smp-groupTitleRow')
  assert.equal(nodes[1].props.className, 'smp-groupSub')
  assert.equal(nodes[1].children[0], '全局 · 配置文件 5 个')
})

test('groupHead：折叠按钮带 chevron 与标题，点击回调生效', () => {
  let toggles = 0
  const nodes = groupHead({ h, Chevron, open: false, onToggle: () => { toggles += 1 }, title: '项目级 MCP', subText: 's' })
  const [toggle] = nodes[0].children
  assert.equal(toggle.props.className, 'smp-groupToggle')
  assert.equal(toggle.children[0].props.open, false)
  assert.equal(toggle.children[1].children[0], '项目级 MCP')
  toggle.props.onClick()
  assert.equal(toggles, 1)
})

test('groupHead：动作按钮原样放在标题行内', () => {
  const action = h('button', { className: 'smp-button', key: 'add' }, '添加服务器')
  const nodes = groupHead({ h, Chevron, open: true, onToggle: () => {}, title: 't', subText: 's', action })
  assert.equal(nodes[0].children[2], action)
})
