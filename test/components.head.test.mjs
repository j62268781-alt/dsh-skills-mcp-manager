/** components/head 接口测试：文案钉住 + 真实 React 元素的树形断言。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { setReact } from '../lib/src/react.js'
import { PAGE_INTRO, PAGE_TITLE, pageHead } from '../lib/src/components/head.jsx'

setReact(React)

test('文案：标题与一行说明', () => {
  assert.equal(PAGE_TITLE, 'Skills & MCP')
  assert.equal(PAGE_INTRO, '全局与项目级分层管理；保存后立即生效。')
})

test('pageHead：产出 .smp-pageHead，且标题/说明各就各位', () => {
  const node = pageHead()
  assert.equal(node.props.className, 'smp-pageHead')
  const inner = React.Children.toArray(React.Children.toArray(node.props.children)[0].props.children)
  assert.equal(inner[0].type, 'h2')
  assert.equal(inner[0].props.className, 'smp-pageTitle')
  assert.equal(inner[0].props.children, PAGE_TITLE)
  assert.equal(inner[1].props.children, PAGE_INTRO)
})
