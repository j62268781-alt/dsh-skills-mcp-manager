/**
 * Client-half delete flow, exercised for real: the bundled panel is loaded the way
 * the ModuleLoader loads it and rendered through a minimal hook runtime
 * (see scripts/lib/client-harness.mjs).
 *
 * The two bugs this guards against only appear *after* a state transition
 * (click 删除 → receipt arrives), not in a pure function.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle, textOf, visit } from '../scripts/lib/client-harness.mjs'

test('客户端删除流程：删除中不出现按钮边框，回执到达后卡片立刻消失且不留幽灵', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc())
  const { doc, runtime, find, byClass, byText, click, change, restore } = panel

  try {
    // 1) Create a skill the way the panel does, so the optimistic card exists.
    click(find((node) => String(node.props.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills')))
    click(byClass('smp-button', '添加技能'))
    change(panel.byPlaceholder('例如 my-skill'), 'test-skills')
    change(panel.byPlaceholder('一句话说明何时使用它'), 'test-skills')
    click(byText('创建'))
    const createNonce = doc.skillRequest.nonce
    assert.equal(doc.skillRequest.op, 'create', '创建请求没有写进设置文档')

    // Host answers and the re-scan lists the new skill on disk.
    doc.skillResult = { ok: true, reason: '', name: 'test-skills', body: '', at: new Date().toISOString(), nonce: createNonce }
    doc.discoveredSkills = [{ name: 'test-skills', description: 'test-skills', path: '/tmp/smp-home/.agents/skills/test-skills/SKILL.md', source: 'user-agents', scope: 'global' }]
    runtime.render()
    assert.ok(find((node) => textOf(node).includes('test-skills') && String(node.props.className ?? '').includes('smp-card')), '创建后没有出现卡片')

    // 创建的回执已经被消费掉了，换成一条不会匹配任何 nonce 的惰性回执（at 为空，
    // 连「新鲜回执」的兜底匹配也不会命中）。否则创建与删除落在同一毫秒时，
    // nonce 会撞车、上一次的回执被当成删除的回执，删除中的状态就一闪而过了。
    doc.skillResult = { ok: false, reason: '', name: '', body: '', at: '', nonce: 'consumed' }
    runtime.render()

    // 2) Delete it: while in flight the card must show a plain status, not a button.
    click(find((node) => String(node.props.className ?? '').includes('smp-button')
      && String(node.props['data-variant']) === 'danger' && textOf(node).trim() === '删除'))
    click(byText('删除'))
    assert.equal(doc.skillRequest.op, 'delete', '删除请求没有写进设置文档')
    const actions = find((node) => String(node.props.className ?? '').includes('smp-cardActions') && textOf(node).includes('删除中…'))
    assert.ok(actions !== null, '删除进行中没有显示「删除中…」状态')
    let buttonInside = false
    visit(actions, (node) => { if (node.type === 'button') buttonInside = true })
    // The danger button's own border used to frame the status as a stray pill.
    assert.equal(buttonInside, false, '删除中的状态被渲染在按钮里（会多出一个圆角边框）')

    // 3) The receipt arrives while the renderer's mirror still lists the skill:
    //    the card must go at once and must not come back as an optimistic ghost.
    doc.skillResult = { ok: true, reason: '', name: 'test-skills', body: '', at: new Date().toISOString(), nonce: doc.skillRequest.nonce }
    runtime.render()
    assert.equal(find((node) => String(node.props.className ?? '').includes('smp-card') && textOf(node).includes('test-skills')), null,
      '回执到达后卡片还在（设置文档还没跟上）')
    doc.discoveredSkills = []
    runtime.render()
    assert.equal(find((node) => String(node.props.className ?? '').includes('smp-card') && textOf(node).includes('test-skills')), null,
      '文档跟上后又冒出幽灵卡片')
  } finally {
    restore()
  }
})
