/**
 * 表单样式里两条**布局契约**，都是踩过的坑。
 *
 * 这个文件只读 `panel.css`，不渲染 —— 因为要钉住的东西在 CSS 里，而「渲染出来看起来对」
 * 证明不了「换行以后还对」。上一版的 `.smp-inlineCheck` 在单行文案下完全正常，正是这种
 * 假阳性让它活到了用户看见为止。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'src', 'styles', 'panel.css'), 'utf8')

/** 取一个选择器的规则体（第一处匹配）。找不到返回 null。 */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  return match === null ? null : match[1]
}

test('开关行不能有固定高度', () => {
  /**
   * `.smp-inlineCheck { height: 32px }` 是这次问题的根因：这些说明几乎都是整句话，
   * 两行 13px/18px 需要 36px，固定 32px 就把第二行压在第一行上。
   *
   * 固定高度只在「内容必然是一行」时安全，而这里的内容是用户可读的自然语言 ——
   * 换行是常态。所以钉住「没有固定 height」，而不是钉住某个具体像素（那样换个数字
   * 又能绕过）。
   */
  const body = ruleBody('.smp-switchRow')
  assert.ok(body !== null, '找不到 .smp-switchRow 规则')
  assert.equal(/[^-]height\s*:/.test(body), false, `.smp-switchRow 不该有固定 height（换行会被裁掉）：${body}`)
})

test('开关行按首行对齐，且文字列可以收缩换行', () => {
  const body = ruleBody('.smp-switchRow')
  // `flex-start`：两行文字时开关应对齐第**一**行，而不是浮在两行中间。
  assert.match(body, /align-items\s*:\s*flex-start/, '开关行必须 align-items:flex-start')
  // 文字列缺 `min-width: 0` 会取 max-content 宽度，在 flex 行里直接溢出对话框。
  const textBody = ruleBody('.smp-switchRowText')
  assert.ok(textBody !== null, '找不到 .smp-switchRowText 规则')
  assert.match(textBody, /min-width\s*:\s*0/, '文字列必须 min-width:0，否则长句子会把对话框撑破')
  assert.match(textBody, /flex-direction\s*:\s*column/, '标题与说明应是上下两行，不是一行')
})

test('旧的勾选框样式已删除（不是留着但没人用）', () => {
  /**
   * 死样式比没有样式更糟：下一个人会照着它写新控件，然后把同一个固定高度的 bug 再犯一次。
   * 引用清零之后就必须删掉。
   */
  assert.equal(CSS.includes('.smp-inlineCheck'), false, '`.smp-inlineCheck` 已无引用，应删除而不是留着')
})

test('字段标签与控件之间的间距不小于 6px', () => {
  // 4px 时两行标签和下面的控件读起来像一块，且换行后更挤。
  const body = ruleBody('.smp-field')
  assert.ok(body !== null, '找不到 .smp-field 规则')
  const gap = body.match(/gap\s*:\s*(\d+)px/)
  assert.ok(gap !== null, '.smp-field 应显式声明 gap')
  assert.ok(Number(gap[1]) >= 6, `字段内间距至少 6px，实际 ${gap[1]}px`)
})
