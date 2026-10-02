/** components/head 接口测试：标题与说明文案可被钉住。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PAGE_INTRO, PAGE_TITLE, pageHead } from '../lib/src/components/head.js'

test('文案：标题与一行说明', () => {
  assert.equal(PAGE_TITLE, 'Skills & MCP')
  assert.equal(PAGE_INTRO, '全局与项目级分层管理；保存后立即生效。')
})

test('pageHead：产出 .smp-pageHead 且含标题与说明节点', () => {
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const node = pageHead(h)
  assert.equal(node.props.className, 'smp-pageHead')
  const texts = JSON.stringify(node)
  assert.ok(texts.includes('Skills & MCP'))
  assert.ok(texts.includes('全局与项目级分层管理'))
  assert.ok(texts.includes('smp-pageTitle'))
})
