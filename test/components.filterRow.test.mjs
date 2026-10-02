/** components/filterRow 接口测试：搜索框、项目选择器、自定义路径模式。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterRow } from '../lib/src/components/filterRow.js'

/** createElement 替身：像 React 一样把嵌套数组摊平。 */
const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
const base = {
  h, query: '', onQuery: () => {}, project: '', projectChoices: [['/p/a', 'A']],
  customProject: false, onCustomProject: () => {}, onProject: () => {}, placeholder: '搜索名称',
}

test('默认态：两个子元素（搜索 + 下拉），无"选工作区"按钮', () => {
  const node = filterRow(base)
  assert.equal(node.props.className, 'smp-filterRow')
  assert.equal(node.children.length, 2)
  const [search, picker] = node.children
  assert.equal(search.children[0].props.className, 'smp-searchIcon')
  assert.equal(search.children[1].props.placeholder, '搜索名称')
  assert.equal(picker.type, 'select')
  assert.equal(picker.props['data-placeholder'], 'true')
  assert.equal(picker.children[0].children[0], '请选择项目')
  assert.equal(picker.children[2].children[0], '自定义路径…')
})

test('搜索框输入触发 onQuery', () => {
  const seen = []
  const node = filterRow({ ...base, onQuery: (v) => seen.push(v) })
  node.children[0].children[1].props.onChange({ target: { value: 'git' } })
  assert.deepEqual(seen, ['git'])
})

test('选中工作区后：占位标记消失、value 指回该路径', () => {
  const node = filterRow({ ...base, project: '/p/a' })
  assert.equal(node.children[1].props['data-placeholder'], 'false')
  assert.equal(node.children[1].props.value, '/p/a')
})

test('自定义模式：变成输入框并多出"选工作区"按钮，点它退出', () => {
  let back = 0
  const node = filterRow({ ...base, customProject: true, onCustomProject: () => { back += 1 } })
  assert.equal(node.children.length, 3)
  assert.equal(node.children[1].type, 'input')
  assert.equal(node.children[1].props.placeholder, '项目绝对路径')
  node.children[2].props.onClick()
  assert.equal(back, 1)
})

test('下拉选择：自定义路径进入自定义模式，具体路径回调传出', () => {
  const events = []
  const node = filterRow({ ...base, onCustomProject: (v) => events.push(['custom', v]), onProject: (v) => events.push(['pick', v]) })
  node.children[1].props.onChange({ target: { value: '__custom__' } })
  node.children[1].props.onChange({ target: { value: '/p/a' } })
  // 选具体路径会先退出自定义模式，再回调选中项
  assert.deepEqual(events, [['custom', true], ['custom', false], ['pick', '/p/a']])
})
