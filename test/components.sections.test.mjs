/** components/sections 接口测试：分组副标题与空态文案。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyMcpText, emptySearchText, emptySkillText, globalMcpSubtitle,
  globalSkillSubtitle, projectMcpSubtitle, projectSkillSubtitle,
} from '../lib/src/components/sections.js'

test('全局 MCP 副标题：带配置文件数量与备份说明', () => {
  const text = globalMcpSubtitle(5)
  assert.match(text, /全局 · 配置文件 5 个/)
  assert.match(text, /cordis\.patch\.yml/)
  assert.match(text, /自动备份/)
})

test('项目级 MCP 副标题：未选择项目时给出提示，选中时带工作区名', () => {
  assert.equal(projectMcpSubtitle('', 0), '未选择项目 · 面板添加的条目只挂载到该项目内运行的 agent')
  assert.equal(projectMcpSubtitle('tcl_jiguang', 2), 'tcl_jiguang · 面板添加 2 个 · 只挂载到该项目内运行的 agent')
})

test('技能副标题：全局写 $DSH_HOME/skills，项目级写 <项目>/.agents/skills', () => {
  assert.match(globalSkillSubtitle(3), /\$DSH_HOME\/skills\//)
  assert.equal(projectSkillSubtitle('tcl_jiguang', 1), 'tcl_jiguang · 面板添加 1 个 · 写入 <项目>/.agents/skills/')
  assert.equal(projectSkillSubtitle('', 0), '未选择项目')
})

test('空态文案：用工作区短名而不是全路径', () => {
  const text = emptyMcpText('tcl_jiguang')
  assert.match(text, /^tcl_jiguang 还没有项目级 MCP/)
  assert.match(text, /「添加服务器」/)
  assert.match(text, /「导入 MCP」/)
  assert.equal(emptySkillText('tcl_jiguang'), 'tcl_jiguang 还没有项目级技能。')
  assert.equal(emptySearchText('github'), '没有匹配「github」的条目')
})
