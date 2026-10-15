/**
 * components/filterRow 接口测试：搜索框 + 页签主操作（真实 React）。
 *
 * 这里曾经有一组关于「项目选择器」的测试（下拉、自定义路径模式、「选工作区」按钮）。
 * 那个选择器已经**从两个页签都删掉了**：MCP 的作用域在服务器自己的表单里选，而 Skills
 * 列表现在跨工作区展示、新增时才在对话框里选工作区。留着它就是一个筛选不到任何东西的控件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { filterRow } from '../lib/src/components/filterRow.jsx'

globalThis.__dshReact = React

const kids = (node) => React.Children.toArray(node.props.children)
const base = { query: '', onQuery: () => {}, placeholder: '搜索名称' }

test('没有项目选择器：只剩搜索框（没有操作时只有一个子元素）', () => {
  const node = filterRow(base)
  assert.equal(node.props.className, 'smp-filterRow')
  // React.Children.toArray 会把 null 去掉，所以「没有操作」时确实只剩搜索框一个子元素。
  const children = kids(node)
  assert.equal(children.length, 1)
  assert.equal(children[0].props.className, 'smp-search')
})

test('搜索框结构与占位文案', () => {
  const [search] = kids(filterRow(base))
  const [icon, input] = kids(search)
  assert.equal(icon.props.className, 'smp-searchIcon')
  assert.equal(input.props.placeholder, '搜索名称')
  assert.equal(input.props.value, '')
})

test('搜索框输入触发 onQuery', () => {
  const seen = []
  const [search] = kids(filterRow({ ...base, onQuery: (v) => seen.push(v) }))
  kids(search)[1].props.onChange({ target: { value: 'git' } })
  assert.deepEqual(seen, ['git'])
})

test('主操作渲染在搜索框之后（同一个槽位）', () => {
  const action = React.createElement('button', { key: 'add' }, '添加技能')
  const children = kids(filterRow({ ...base, actions: action }))
  assert.equal(children.length, 2)
  assert.equal(children[0].props.className, 'smp-search')
  // React 会重写 key（'add' -> '.$add'），所以按渲染结果断言而不是实例身份。
  assert.equal(children[1].type, 'button')
  assert.equal(children[1].props.children, '添加技能')
})

test('删除的项目选择器不会再出现', () => {
  // 传了旧的 props 也不该渲染出控件（调用方已不再传，但这条挡住"顺手加回来"）
  const node = filterRow({
    ...base, project: '/p/a', projectChoices: [['/p/a', 'A']],
    customProject: false, onCustomProject: () => {}, onProject: () => {},
  })
  const walk = (n, found = []) => {
    if (n === null || n === undefined || typeof n !== 'object') return found
    if (Array.isArray(n)) { n.forEach((c) => walk(c, found)); return found }
    found.push(n)
    walk(n.props?.children, found)
    return found
  }
  const types = walk(node).map((el) => el.type)
  assert.ok(!types.includes('select'), '不该渲染项目下拉')
  assert.ok(!types.includes('datalist'), '不该渲染路径补全')
})
