/** components/tabs 接口测试：标签文案、激活态与切换回调。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TAB_ITEMS, tabStrip } from '../lib/src/components/tabs.js'

const h = (type, props, ...children) => ({ type, props: props ?? {}, children })

test('TAB_ITEMS：MCP 在 Skills 之前', () => {
  assert.deepEqual(TAB_ITEMS.map((t) => t.id), ['mcp', 'skills'])
})

test('tabStrip：标签带计数，激活态只落在一个上', () => {
  const node = tabStrip({ h, active: 'skills', counts: { mcp: 5, skills: 0 }, onSelect: () => {} })
  assert.equal(node.props.className, 'smp-tabs')
  const [mcp, skills] = node.children
  assert.equal(mcp.children[0], 'MCP（5）')
  assert.equal(skills.children[0], 'Skills（0）')
  assert.equal(mcp.props['data-active'], false)
  assert.equal(skills.props['data-active'], true)
})

test('tabStrip：点击回调传出 tab id', () => {
  const picked = []
  const node = tabStrip({ h, active: 'mcp', counts: {}, onSelect: (id) => picked.push(id) })
  node.children[0].props.onClick()
  node.children[1].props.onClick()
  assert.deepEqual(picked, ['mcp', 'skills'])
})

test('tabStrip：缺计数时显示 0，不显示 undefined', () => {
  const node = tabStrip({ h, active: 'mcp', onSelect: () => {} })
  assert.equal(node.children[0].children[0], 'MCP（0）')
  assert.equal(node.children[1].children[0], 'Skills（0）')
})
