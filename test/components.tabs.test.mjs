/** components/tabs 接口测试：标签文案、激活态与切换回调（真实 React 元素）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { TAB_ITEMS, tabStrip } from '../lib/src/components/tabs.jsx'

globalThis.__dshReact = React

const kids = (node) => React.Children.toArray(node.props.children)

test('TAB_ITEMS：MCP 在 Skills 之前', () => {
  assert.deepEqual(TAB_ITEMS.map((t) => t.id), ['mcp', 'skills'])
})

test('tabStrip：标签带计数，激活态只落在一个上', () => {
  const node = tabStrip({ active: 'skills', counts: { mcp: 5, skills: 0 }, onSelect: () => {} })
  assert.equal(node.props.className, 'smp-tabs')
  const [mcp, skills] = kids(node)
  assert.equal(mcp.props.className, 'smp-tab')
  assert.equal(mcp.props.children, 'MCP（5）')
  assert.equal(skills.props.children, 'Skills（0）')
  assert.equal(mcp.props['data-active'], false)
  assert.equal(skills.props['data-active'], true)
})

test('tabStrip：点击回调传出 tab id', () => {
  const picked = []
  const [mcp, skills] = kids(tabStrip({ active: 'mcp', counts: {}, onSelect: (id) => picked.push(id) }))
  mcp.props.onClick()
  skills.props.onClick()
  assert.deepEqual(picked, ['mcp', 'skills'])
})

test('tabStrip：缺计数时显示 0', () => {
  const [mcp, skills] = kids(tabStrip({ active: 'mcp', onSelect: () => {} }))
  assert.equal(mcp.props.children, 'MCP（0）')
  assert.equal(skills.props.children, 'Skills（0）')
})
