/**
 * components/sections 接口测试：空态文案。
 *
 * 分组副标题随分组一起移除了（两个页签现在都是一份列表 + 一行 summary），所以这里只钉
 * 空态。空态最容易出的错是「标签为空时留下一个前导空格」，那看起来像渲染坏了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyMcpText, emptySearchText, emptySkillText } from '../lib/src/components/sections.js'

test('技能空态：无标签时自成一句，不留前导空格', () => {
  const text = emptySkillText('')
  assert.equal(text, '还没有技能 —— 点上面「添加技能」，保存后写入磁盘。')
  assert.ok(!text.startsWith(' '), '文案不能以空格开头（旧实现在标签为空时会）')
  assert.match(text, /「添加技能」/)
})

test('技能空态：带工作区名时点名该工作区', () => {
  const text = emptySkillText('tcl_jiguang')
  assert.match(text, /^tcl_jiguang 还没有技能/)
  assert.match(text, /「添加技能」/)
  // 空白标签与未传值走同一分支，不能产生 " 还没有…"
  assert.equal(emptySkillText('   '), emptySkillText(undefined))
})

test('MCP 空态：无标签与带标签都不留前导空格', () => {
  const bare = emptyMcpText('')
  assert.equal(bare, '还没有 MCP 服务器 —— 可以点「添加服务器」，或用「导入 MCP」从其他工具导入。')
  assert.ok(!bare.startsWith(' '), '文案不能以空格开头')
  const named = emptyMcpText('tcl_jiguang')
  assert.match(named, /^tcl_jiguang 还没有 MCP 服务器/)
  assert.match(named, /「添加服务器」/)
  assert.match(named, /「导入 MCP」/)
  assert.equal(emptyMcpText(undefined), bare)
})

test('搜索空态：带上查询词', () => {
  assert.equal(emptySearchText('github'), '没有匹配「github」的条目')
})
