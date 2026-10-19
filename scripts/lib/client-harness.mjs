/**
 * Client-half test harness: loads the built panel bundle the way the ModuleLoader
 * loads it and renders it through a minimal hook runtime.
 *
 * Why a hand-rolled runtime instead of a DOM: this package ships no DOM shim, and
 * the behaviour worth guarding (delete receipts, optimistic cards, form drafts)
 * only appears *after* a state transition. The runtime implements exactly what the
 * panel uses — createElement, Fragment and the four hooks — and expands function
 * components during the tree walk, so the whole render path actually executes.
 *
 * The bundle is a build artifact (`npm run build:client`, which `npm run gate`
 * runs before the tests), so callers skip instead of failing when it is absent.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
/** Built client bundle, relative to the repository root. */
export const BUNDLE = join(here, '..', '..', 'lib', 'client.js')
/** Skip reason for a test that needs the bundle, or `false` when it is present. */
export const skipWithoutBundle = () => (existsSync(BUNDLE) ? false : '缺少 lib/client.js（先跑 npm run build:client）')

/**
 * The bundle's factory, cached across `bootPanel` calls.
 *
 * ESM caches the module, so a second `import()` would not re-run
 * `__ModuleLoader__.load` — the tests below boot the panel several times in one
 * process, so the captured factory is reused with a fresh React/runtime instead.
 */
let cachedFactory = null

export function createElement(type, config, ...children) {
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
export function createRuntime() {
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
    dispose() {
      for (const slot of hooks) if (typeof slot.cleanup === 'function') slot.cleanup()
    },
    get tree() { return tree },
  }
  return runtime
}

export function visit(node, fn) {
  if (Array.isArray(node)) { node.forEach((child) => visit(child, fn)); return }
  if (node === null || node === undefined || typeof node !== 'object' || node.element !== true) return
  fn(node)
  if (typeof node.type === 'function') {
    visit(node.type({ ...node.props, children: node.children }), fn)
    return
  }
  visit(node.children, fn)
}

export function textOf(node) {
  let out = ''
  visit(node, (element) => {
    if (typeof element.type !== 'string') return
    for (const child of element.children) if (typeof child === 'string' || typeof child === 'number') out += child
  })
  return out
}

/** The settings document shape the panel expects, with sensible empty defaults. */
export function emptyDoc(overrides = {}) {
  return {
    servers: [], skills: [], rowOps: [], rowOpsReady: true,
    profileServers: [], workspaces: [], currentWorkspace: '',
    skillDirs: { userDsh: '/tmp/smp-home/skills', userAgents: '/tmp/smp-home/.agents/skills' },
    discoveryInfo: { at: '', roots: [], count: 0, error: '' },
    discoveredSkills: [],
    skillResult: { ok: false, reason: '', name: '', body: '', at: '', nonce: '' },
    skillRequest: { op: '', scope: '', id: '', project: '', path: '', name: '', prevName: '', description: '', body: '', nonce: '' },
    ...overrides,
  }
}

/**
 * Boot the panel against `doc` and render it once.
 *
 * Returns query/act helpers plus `restore()`, which the caller must run in a
 * `finally` block (the panel schedules intervals and reads `window`/`location`).
 */
export async function bootPanel(doc = emptyDoc(), options = {}) {
  const realFetch = globalThis.fetch
  const realClearInterval = globalThis.clearInterval
  const realClearTimeout = globalThis.clearTimeout
  /**
   * Default fetch: answers **all three** panel endpoints.
   *
   * `/runtime` is the read route, `/rows` is the MCP command route, and `/skills` is the skill
   * **write** route — they have different payloads, and one blanket stub would hand a command
   * route a runtime body, so every command would look rejected. `options.fetch` still replaces
   * the whole thing.
   */
  globalThis.fetch = options.fetch ?? (async (url, init) => {
    const target = String(url)
    if (target.includes('/skill?') || target.endsWith('/skill')) {
      // Skill **body read** (GET). The Host validates the path against its own scan.
      return { ok: true, status: 200, json: async () => doc.skillReadResult ?? { ok: true, body: doc.skillBody ?? '' } }
    }
    if (target.endsWith('/skills')) {
      // Record the write so a test can assert the HTTP path was taken, and echo the Host's
      // receipt shape. Rejections are driven by `options.fetch` or by `doc.skillCommandResult`.
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body))
      const commands = doc.skillCommands ?? []
      commands.push(body)
      doc.skillCommands = commands
      if (doc.skillCommandResult !== undefined) return { ok: true, status: 200, json: async () => doc.skillCommandResult }
      return { ok: true, status: 200, json: async () => ({ ok: true, reason: '', name: body.name ?? '', at: new Date().toISOString() }) }
    }
    if (target.endsWith('/reconnect')) {
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body))
      const commands = doc.reconnectCommands ?? []
      commands.push(body)
      doc.reconnectCommands = commands
      return { ok: true, status: 200, json: async () => doc.reconnectResult ?? { ok: true, reason: '' } }
    }
    if (target.endsWith('/import')) {
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body))
      const commands = doc.importCommands ?? []
      commands.push(body)
      doc.importCommands = commands
      return { ok: true, status: 200, json: async () => doc.importResultPayload ?? { ok: true, ...body, files: [], servers: [] } }
    }
    if (target.endsWith('/rows')) {
      // Record the command so a test can assert the HTTP path was taken, and echo the Host's
      // success shape. Rejections are driven by `options.fetch` or by pre-seeding `rowCommands`.
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body))
      const commands = doc.rowCommands ?? []
      commands.push(body)
      doc.rowCommands = commands
      if (doc.rowCommandResult !== undefined) return { ok: true, status: 200, json: async () => doc.rowCommandResult }
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, reason: '', servers: doc.runtimeServers ?? doc.profileServers ?? [] }),
      }
    }
    // Counted so a test can prove the panel **re-fetched** after a nudge (e.g. the OAuth
    // callback's BroadcastChannel message) instead of waiting for its poll.
    doc.runtimeFetches = (doc.runtimeFetches ?? 0) + 1
    return {
      ok: true, status: 200,
      json: async () => ({
        serverTools: doc.serverTools ?? [], serverStatus: doc.serverStatus ?? [],
        serverToolsError: doc.serverToolsError ?? { reason: '', detail: '' },
        // Mirrors the real Host: `/runtime` carries every read model.
        servers: doc.runtimeServers ?? doc.profileServers ?? [],
        skills: doc.runtimeSkills ?? doc.discoveredSkills ?? [],
        skillDirs: doc.skillDirs ?? { userDsh: '/tmp/smp-home/skills', userAgents: '/tmp/smp-home/.agents/skills' },
        workspaces: doc.runtimeWorkspaces ?? doc.workspaces ?? [],
        currentWorkspace: doc.runtimeCurrentWorkspace ?? doc.currentWorkspace ?? '',
        filter: doc.runtimeFilter ?? doc.filterState ?? {},
        probe: doc.runtimeProbe ?? doc.probeState ?? {},
        oauth: { ...(doc.oauthState ?? {}), servers: doc.oauthServers ?? {} },
        discovery: doc.discoveryInfo ?? {},
      }),
    }
  })
  /**
   * Minimal `BroadcastChannel`: the panel subscribes to the OAuth channel and reloads on a
   * message. Captured so a test can *deliver* that message — the real Channel would need two
   * live pages, which this harness does not have.
   */
  const channels = []
  const realBroadcastChannel = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = class {
    constructor(name) { this.name = name; this.listeners = []; channels.push(this) }
    addEventListener(_type, fn) { this.listeners.push(fn) }
    removeEventListener(_type, fn) { this.listeners = this.listeners.filter((item) => item !== fn) }
    close() {}
    /** Test-only: deliver a message to this page. */
    emit(data) { for (const fn of this.listeners) fn({ data }) }
  }

  const realInterval = globalThis.setInterval
  const realTimeout = globalThis.setTimeout
  globalThis.setInterval = (fn, ms) => { options.onInterval?.(fn, ms); return 0 }
  globalThis.setTimeout = () => 0
  globalThis.clearInterval = () => {}
  globalThis.clearTimeout = () => {}

  const form = {
    getSnapshot: () => ({ value: doc, status: 'ready', revision: 1 }),
    set: (field, value) => { doc[field] = value; return Promise.resolve(true) },
  }

  let React = null
  let loaded = null
  let captured = null
  const runtime = createRuntime()
  globalThis.location = { search: '' }
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec.factory
        loaded = spec.factory((name) => {
          if (name === 'react') return React
          // The dialogs render nothing without these primitives, and the delete
          // confirmation is exactly what a delete-flow test has to click through.
          if (name === '@deepseek-ai/dsh-client-ui-primitives') {
            return {
              Modal: (props) => createElement('div', { 'data-modal': props.title, key: 'modal' }, props.description, props.footer, props.children),
              Button: 'button',
              // Mirrors the Host's real Switch contract (button[role=switch] keyed off
              // aria-checked, onChange called with the *next* value) so tests exercise the
              // same code path production takes, not the fallback branch.
              Switch: (props) => createElement('button', {
                type: 'button', role: 'switch', 'aria-checked': props.checked,
                'aria-label': props.label, disabled: props.disabled,
                className: `smp-switch-stub ${props.className ?? ''}`.trim(),
                onClick: () => props.onChange(!props.checked),
              }),
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
  const findAll = (predicate) => {
    const hits = []
    visit(runtime.tree, (node) => { if (typeof node.type === 'string' && predicate(node)) hits.push(node) })
    return hits
  }
  const byClass = (className, text) => find((node) => String(node.props.className ?? '').split(/\s+/).includes(className)
    && (text === undefined || textOf(node).trim() === text))
  const byText = (text) => find((node) => node.type === 'button' && textOf(node).trim() === text)
  /**
   * Every text node currently rendered, as one string.
   *
   * For assertions about prose (a note, a warning) where the exact element does not
   * matter — only that the sentence reached the page. Whitespace is collapsed so a
   * multi-line JSX literal can still be matched with a plain regex.
   */
  const text = () => {
    const parts = []
    visit(runtime.tree, (node) => {
      for (const child of Array.isArray(node.children) ? node.children : [node.children]) {
        if (typeof child === 'string' || typeof child === 'number') parts.push(String(child))
      }
    })
    return parts.join(' ').replace(/\s+/g, ' ')
  }
  const byPlaceholder = (placeholder) => find((node) => node.props.placeholder === placeholder)
  const click = (node) => {
    assert.ok(node?.props?.onClick, `找不到可点击的节点：${node?.props?.className ?? node?.type ?? 'undefined'}`)
    node.props.onClick({})
    runtime.render()
  }
  /**
   * Click a card's `…` trigger and return the popup element, or null.
   *
   * 重连/编辑/删除 都收进了 popup，所以任何针对它们的断言都必须先开菜单。这个助手
   * 存在的意义是别让每个测试各写一遍「找到第 N 个触发器」的位置式查找 —— 那种写法
   * 在卡片顺序变化时会静默指向另一张卡片。
   */
  const openMenu = (index = 0) => {
    const triggers = findAll((node) => String(node.props.className ?? '') === 'smp-moreTrigger')
    if (triggers.length <= index) return null
    click(triggers[index])
    return find((node) => String(node.props.className ?? '') === 'smp-menu')
  }
  const change = (node, value) => {
    assert.ok(node?.props?.onChange, '找不到可输入的节点')
    node.props.onChange({ target: { value } })
    runtime.render()
  }
  const toggle = (node, checked) => {
    assert.ok(node?.props?.onChange, '找不到可切换的节点')
    node.props.onChange({ target: { checked } })
    runtime.render()
  }
  /**
   * Find a switch by its accessible name.
   *
   * Boolean settings render the Host's `Switch` (`button[role=switch]`), **not** an
   * `<input type=checkbox>` — so `toggle()`'s `{target:{checked}}` contract does not apply;
   * a switch's `onChange` receives the next boolean directly. Keeping the two contracts in
   * separate helpers means a test cannot silently pass an event object to a switch and read
   * the resulting `!undefined` as "on".
   */
  const switchNamed = (name) => {
    if (name === undefined) return find((node) => node.props.role === 'switch')
    return find((node) => node.props.role === 'switch' && String(node.props['aria-label'] ?? '') === name)
  }
  /** Flip the switch whose accessible name is `name`; returns it for a state assertion. */
  const flip = (name) => {
    const node = switchNamed(name)
    assert.ok(node, `找不到名为「${name}」的开关`)
    node.props.onClick({})
    runtime.render()
    return switchNamed(name)
  }

  React = {
    createElement,
    Fragment: 'Fragment',
    useState: (...args) => runtime.useState(...args),
    useEffect: (...args) => runtime.useEffect(...args),
    useMemo: (...args) => runtime.useMemo(...args),
    useRef: (...args) => runtime.useRef(...args),
  }
  if (cachedFactory === null) {
    await import(pathToFileURL(BUNDLE).href)
    assert.ok(captured !== null, '客户端 bundle 没有调用 __ModuleLoader__.load')
    cachedFactory = captured
  } else {
    // 第二次起复用工厂：ESM 不会重新执行 bundle，自己把它跑一遍。
    loaded = cachedFactory((name) => {
      if (name === 'react') return React
      if (name === '@deepseek-ai/dsh-client-ui-primitives') {
        return {
          Modal: (props) => createElement('div', { 'data-modal': props.title, key: 'modal' }, props.description, props.footer, props.children),
          Button: 'button',
          Switch: (props) => createElement('button', {
            type: 'button', role: 'switch', 'aria-checked': props.checked,
            'aria-label': props.label, disabled: props.disabled,
            className: `smp-switch-stub ${props.className ?? ''}`.trim(),
            onClick: () => props.onChange(!props.checked),
          }),
        }
      }
      throw new Error(`test runtime: unknown module ${name}`)
    })
  }

  loaded.apply({
    slots: {
      inject: (_name, fn) => fn(),
      register: (entry, Component) => { runtime.props = entry.inject(); runtime.setComponent(Component) },
    },
    configForms: { get: () => form },
  })
  runtime.render()
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
    runtime.render()
  }
  await settle()

  const restore = () => {
    runtime.dispose()
    globalThis.fetch = realFetch
    globalThis.clearInterval = realClearInterval
    globalThis.clearTimeout = realClearTimeout
    globalThis.setInterval = realInterval
    globalThis.setTimeout = realTimeout
    delete globalThis.window
    delete globalThis.location
    if (realBroadcastChannel === undefined) delete globalThis.BroadcastChannel
    else globalThis.BroadcastChannel = realBroadcastChannel
  }

  return { doc, runtime, settle, find, findAll, byClass, byText, byPlaceholder, click, change, toggle, switchNamed, flip, text, openMenu, restore, channels }
}
