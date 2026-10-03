/**
 * Client-half delete flow, exercised for real: the bundled panel is loaded the
 * way the ModuleLoader loads it and rendered through a minimal hook runtime.
 *
 * Why a hand-rolled runtime instead of a DOM: this package ships no DOM shim, and
 * the two bugs this guards against only appear *after* a state transition
 * (click 删除 → receipt arrives), not in a pure function. The runtime below
 * implements exactly what the panel uses — createElement, Fragment and the four
 * hooks — and expands function components during the tree walk, so the whole
 * render path (cards, dialogs, the receipt effect) actually executes.
 *
 * The bundle is a build artifact (`npm run build:client`, which `npm run gate`
 * runs before the tests), so this test skips instead of failing when it is absent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(here, '..', 'lib', 'client.js')

/* ------------------------------------------------------------------ runtime */
function createElement(type, config, ...children) {
  const props = {}
  if (config) for (const key of Object.keys(config)) if (key !== 'children' && key !== 'key') props[key] = config[key]
  const kids = []
  const push = (child) => {
    if (child === null || child === undefined || child === false || child === true) return
    if (Array.isArray(child)) { child.forEach(push); return }
    kids.push(child)
  }
  push(config?.children)
  children.forEach(push)
  return { element: true, type, props, children: kids, key: config?.key }
}

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

/** Minimal hook runtime: one component (the panel), hooks keyed by call order. */
function createRuntime() {
  let hooks = []
  let cursor = 0
  let pending = []
  let dirty = false
  let Component = null
  let tree = null

  const runtime = {
    props: null,
    setComponent(next) { Component = next },
    useState(initial) {
      const slot = (hooks[cursor++] ??= {})
      if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        dirty = true
      }]
    },
    useEffect(fn, deps) { pending.push({ slot: (hooks[cursor++] ??= {}), fn, deps }) },
    useMemo(fn, deps) {
      const slot = (hooks[cursor++] ??= {})
      if (deps === undefined) return fn()
      if (slot.memoDeps !== undefined && sameDeps(slot.memoDeps, deps)) return slot.memoValue
      slot.memoValue = fn()
      slot.memoDeps = deps
      return slot.memoValue
    },
    useRef(initial) {
      const slot = (hooks[cursor++] ??= {})
      slot.ref ??= { current: initial }
      return slot.ref
    },
    /** Re-render until no effect schedules another pass (React's own contract). */
    render() {
      let guard = 0
      do {
        dirty = false
        cursor = 0
        pending = []
        tree = Component(runtime.props)
        for (const effect of pending) {
          if (effect.deps !== undefined && sameDeps(effect.slot.effectDeps, effect.deps)) continue
          if (typeof effect.slot.cleanup === 'function') effect.slot.cleanup()
          effect.slot.effectDeps = effect.deps
          effect.slot.cleanup = effect.fn()
        }
      } while (dirty && ++guard < 100)
      if (guard >= 100) throw new Error('面板渲染没有收敛（effect 里在无限 setState）')
      return tree
    },
    get tree() { return tree },
  }
  return runtime
}

function visit(node, fn) {
  if (Array.isArray(node)) { node.forEach((child) => visit(child, fn)); return }
  if (node === null || node === undefined || typeof node !== 'object' || node.element !== true) return
  fn(node)
  if (typeof node.type === 'function') {
    visit(node.type({ ...node.props, children: node.children }), fn)
    return
  }
  visit(node.children, fn)
}

function textOf(node) {
  let out = ''
  visit(node, (element) => {
    if (typeof element.type !== 'string') return
    for (const child of element.children) if (typeof child === 'string' || typeof child === 'number') out += child
  })
  return out
}

test('客户端删除流程：删除中不出现按钮边框，回执到达后卡片立刻消失且不留幽灵', { skip: !existsSync(BUNDLE) && '缺少 lib/client.js（先跑 npm run build:client）' }, async () => {
  // The panel starts its own intervals; the runtime drives every render itself.
  const realInterval = globalThis.setInterval
  const realTimeout = globalThis.setTimeout
  globalThis.setInterval = () => 0
  globalThis.setTimeout = () => 0
  globalThis.clearInterval = () => {}
  globalThis.clearTimeout = () => {}

  const doc = {
    servers: [], skills: [], rowOps: [], rowOpsReady: true,
    profileServers: [], workspaces: [], currentWorkspace: '',
    skillDirs: { userDsh: '/tmp/smp-home/skills', userAgents: '/tmp/smp-home/.agents/skills' },
    discoveryInfo: { at: '', roots: [], count: 0, error: '' },
    discoveredSkills: [],
    skillResult: { ok: false, reason: '', name: '', body: '', at: '', nonce: '' },
    skillRequest: { op: '', scope: '', id: '', project: '', path: '', name: '', prevName: '', description: '', body: '', nonce: '' },
  }
  const form = {
    getSnapshot: () => ({ value: doc, status: 'ready', revision: 1 }),
    set: (field, value) => { doc[field] = value; return Promise.resolve(true) },
  }

  let React = null
  let loaded = null
  let runtime = null
  globalThis.location = { search: '' }
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        loaded = spec.factory((name) => {
          if (name === 'react') return React
          // The dialogs render nothing without these primitives, and the delete
          // confirmation is exactly what this test has to click through.
          if (name === '@deepseek-ai/dsh-client-ui-primitives') {
            return {
              Modal: (props) => createElement('div', { 'data-modal': props.title, key: 'modal' }, props.description, props.footer, props.children),
              Button: 'button',
            }
          }
          throw new Error(`test runtime: unknown module ${name}`)
        })
      },
    },
  }

  const find = (predicate) => {
    let hit = null
    visit(runtime.tree, (node) => { if (hit === null && typeof node.type === 'string' && predicate(node)) hit = node })
    return hit
  }
  const byClass = (className, text) => find((node) => String(node.props.className ?? '').split(/\s+/).includes(className)
    && (text === undefined || textOf(node).trim() === text))
  const byText = (text) => find((node) => node.type === 'button' && textOf(node).trim() === text)
  const click = (node) => {
    assert.ok(node?.props?.onClick, `找不到可点击的节点：${node?.props?.className ?? node?.type ?? 'undefined'}`)
    node.props.onClick({})
    runtime.render()
  }
  const change = (node, value) => {
    assert.ok(node?.props?.onChange, '找不到可输入的节点')
    node.props.onChange({ target: { value } })
    runtime.render()
  }

  try {
    runtime = createRuntime()
    React = {
      createElement,
      Fragment: 'Fragment',
      useState: (...args) => runtime.useState(...args),
      useEffect: (...args) => runtime.useEffect(...args),
      useMemo: (...args) => runtime.useMemo(...args),
      useRef: (...args) => runtime.useRef(...args),
    }
    await import(pathToFileURL(BUNDLE).href)
    assert.ok(loaded !== null, '客户端 bundle 没有调用 __ModuleLoader__.load')

    loaded.apply({
      slots: {
        inject: (_name, fn) => fn(),
        register: (entry, Component) => { runtime.props = entry.inject(); runtime.setComponent(Component) },
      },
      configForms: { get: () => form },
    })
    runtime.render()

    // 1) Create a skill the way the panel does, so the optimistic card exists.
    click(find((node) => String(node.props.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills')))
    click(byClass('smp-button', '添加技能'))
    change(find((node) => node.type === 'input' && node.props.placeholder === '例如 my-skill'), 'test-skills')
    change(find((node) => node.type === 'input' && node.props.placeholder === '一句话说明何时使用它'), 'test-skills')
    click(byText('创建'))
    const createNonce = doc.skillRequest.nonce
    assert.equal(doc.skillRequest.op, 'create', '创建请求没有写进设置文档')

    // Host answers and the re-scan lists the new skill on disk.
    doc.skillResult = { ok: true, reason: '', name: 'test-skills', body: '', at: new Date().toISOString(), nonce: createNonce }
    doc.discoveredSkills = [{ name: 'test-skills', description: 'test-skills', path: '/tmp/smp-home/.agents/skills/test-skills/SKILL.md', source: 'user-agents', scope: 'global' }]
    runtime.render()
    assert.ok(find((node) => textOf(node).includes('test-skills') && String(node.props.className ?? '').includes('smp-card')), '创建后没有出现卡片')

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
    globalThis.setInterval = realInterval
    globalThis.setTimeout = realTimeout
    delete globalThis.window
    delete globalThis.location
  }
})
