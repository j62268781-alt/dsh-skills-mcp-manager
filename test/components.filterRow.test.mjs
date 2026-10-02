/** components/filterRow 接口测试：搜索框、项目选择器、自定义路径模式（真实 React）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { filterRow } from '../lib/src/components/filterRow.jsx'

globalThis.__dshReact = React

const kids = (node) => React.Children.toArray(node.props.children)
const base = {
  query: '', onQuery: () => {}, project: '', projectChoices: [['/p/a', 'A']],
  customProject: false, onCustomProject: () => {}, onProject: () => {}, placeholder: '搜索名称',
}

test('默认态：两个子元素（搜索 + 下拉），无"选工作区"按钮', () => {
  const node = filterRow(base)
  assert.equal(node.props.className, 'smp-filterRow')
  const [search, picker] = kids(node)
  assert.equal(kids(search).length, 2)
  assert.equal(kids(search)[1].props.placeholder, '搜索名称')
  assert.equal(picker.type, 'select')
  assert.equal(picker.props['data-placeholder'], true)
  assert.equal(kids(picker)[0].props.children, '请选择项目')
  assert.equal(kids(picker)[2].props.children, '自定义路径…')
})

test('搜索框输入触发 onQuery', () => {
  const seen = []
  const [search] = kids(filterRow({ ...base, onQuery: (v) => seen.push(v) }))
  kids(search)[1].props.onChange({ target: { value: 'git' } })
  assert.deepEqual(seen, ['git'])
})

test('选中工作区后：占位标记消失、value 指回该路径', () => {
  const [, picker] = kids(filterRow({ ...base, project: '/p/a' }))
  assert.equal(picker.props['data-placeholder'], false)
  assert.equal(picker.props.value, '/p/a')
})

test('自定义模式：变成输入框并多出"选工作区"按钮，点它退出', () => {
  let back = 0
  const node = filterRow({ ...base, customProject: true, onCustomProject: () => { back += 1 } })
  const children = kids(node)
  assert.equal(children.length, 3)
  assert.equal(children[1].type, 'input')
  assert.equal(children[1].props.placeholder, '项目绝对路径')
  children[2].props.onClick()
  assert.equal(back, 1)
})

test('下拉选择：自定义路径进入自定义模式，具体路径回调传出', () => {
  const events = []
  const [, picker] = kids(filterRow({ ...base, onCustomProject: (v) => events.push(['custom', v]), onProject: (v) => events.push(['pick', v]) }))
  picker.props.onChange({ target: { value: '__custom__' } })
  picker.props.onChange({ target: { value: '/p/a' } })
  assert.deepEqual(events, [['custom', true], ['custom', false], ['pick', '/p/a']])
})
