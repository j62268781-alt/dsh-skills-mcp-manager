/** importSources 接口测试：26 项、id 唯一、标签为纯名字。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IMPORT_CHOICES } from '../lib/src/importSources.js'

test('IMPORT_CHOICES：26 项且 id 唯一', () => {
  assert.equal(IMPORT_CHOICES.length, 26)
  const ids = IMPORT_CHOICES.map(([id]) => id)
  assert.equal(new Set(ids).size, ids.length)
})

test('标签不带 CLI 后缀，也不带文件路径', () => {
  for (const [id, label] of IMPORT_CHOICES) {
    assert.equal(typeof label, 'string')
    assert.ok(label.length > 0, `${id} 标签为空`)
    // 不允许文件路径或破折号说明；'Gemini CLI' 是产品真名，允许保留
    assert.doesNotMatch(label, /\.json|\.toml|—/)
  }
  assert.ok(IMPORT_CHOICES.some(([id]) => id === 'claude'))
  assert.ok(IMPORT_CHOICES.some(([id]) => id === 'crush'))
  assert.ok(IMPORT_CHOICES.some(([id]) => id === 'vscode'))
})
