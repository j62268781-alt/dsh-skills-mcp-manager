/**
 * patch/rows 接口测试：行定位、插入、改配置字段、启停、删除。
 * 全部是纯函数（对已解析的 yaml Document 操作），不需要 cordis 运行时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDocument } from 'yaml'
import { insertRow, locateRow, removeRow, setRowConfigField, setRowDisabled } from '../src/patch/rows.js'

const PATCH = `- insert:
    - id: mcp-context7
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: context7
        transport: streamable-http
        url: https://mcp.context7.com/mcp
`
const doc = () => parseDocument(PATCH)
const text = (d) => d.toString()

test('locateRow：能找到 insert 列表里的行，未知 id 返回 null', () => {
  const d = doc()
  const found = locateRow(d, 'mcp-context7')
  assert.equal(found?.place, 'insert')
  assert.equal(found?.item.get('id'), 'mcp-context7')
  assert.equal(locateRow(d, 'nope'), null)
  // include: 前缀（Loader 入口 id）要能剥掉
  assert.equal(locateRow(d, 'include:mcp-context7')?.item.get('id'), 'mcp-context7')
})

test('insertRow：追加到已有 insert 指令，且没有 insert 时新建一条', () => {
  const d = doc()
  insertRow(d, 'mcp-new', { serverName: 'new', transport: 'stdio' })
  assert.match(text(d), /- id: mcp-new/)
  assert.equal(doc_count(text(d)), 2)

  const empty = parseDocument('# 空 patch\n')
  insertRow(empty, 'mcp-only', { serverName: 'only' })
  assert.match(text(empty), /- insert:/)
  assert.match(text(empty), /- id: mcp-only/)
})

test('setRowConfigField：写入/删除配置字段，未知行返回 false', () => {
  const d = doc()
  assert.equal(setRowConfigField(d, 'mcp-context7', 'url', 'https://new/mcp'), true)
  assert.match(text(d), /url: https:\/\/new\/mcp/)
  setRowConfigField(d, 'mcp-context7', 'url', null)
  assert.doesNotMatch(text(d), /new\/mcp/)
  assert.equal(setRowConfigField(d, 'ghost', 'url', 'x'), false)
})

test('setRowDisabled：停用写入 disabled，启用移除该字段', () => {
  const d = doc()
  setRowDisabled(d, 'mcp-context7', true)
  assert.match(text(d), /disabled: true/)
  setRowDisabled(d, 'mcp-context7', false)
  assert.doesNotMatch(text(d), /disabled/)
  assert.equal(setRowDisabled(d, 'ghost', true), false)
})

test('removeRow：删除整行且保留兄弟行', () => {
  const d = parseDocument(`${PATCH}    - id: mcp-deepwiki\n      config:\n        serverName: deepwiki\n`)
  assert.equal(removeRow(d, 'mcp-context7'), true)
  const out = text(d)
  assert.doesNotMatch(out, /mcp-context7/)
  assert.match(out, /mcp-deepwiki/)
})

function doc_count(t) {
  return (t.match(/- id: /g) ?? []).length
}
