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

test('开关行：文字在左、开关贴右、两者上下居中', () => {
  /**
   * 布局契约来自用户的读法：整张表单的布尔设置都应读成「这一项叫什么 → 它是哪一档」，
   * 所以开关位置必须固定在右边，不能随文字长短左右浮动；竖直方向则与左侧标题+说明
   * 这一整块居中。
   */
  const body = ruleBody('.smp-switchRow')
  assert.match(body, /align-items\s*:\s*center/, '开关与左侧文字必须上下居中')
  assert.match(body, /justify-content\s*:\s*space-between/, '开关必须贴右：文字与开关之间用 space-between 推开')
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

test('展开详情：键用灰、值用主色（数据要能一眼读出）', () => {
  /**
   * 之前键（`行 id`）和值（那串 id 本身）都是灰的，整块读起来是一片低对比文字 ——
   * 分不清哪个是标签、哪个是内容。值是**数据**，键只是说明，所以值必须是正文色。
   * 反过来（值比键还淡）会让用户以为那串 id 是次要信息。
   */
  const key = ruleBody('.smp-detailsKey')
  const value = ruleBody('.smp-detailsValue')
  assert.ok(key !== null && value !== null, '找不到 .smp-detailsKey / .smp-detailsValue')
  assert.match(key, /label-tertiary/, '键应保持三级灰')
  assert.match(value, /label-primary/, '值必须用主色（正文黑），否则和键糊成一片')
  assert.equal(/label-tertiary|label-secondary/.test(value), false, '值不能再用灰阶')
})
