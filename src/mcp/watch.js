/**
 * 监听每个 MCP 服务器的连接实例，并提供存活探测。
 *
 * 为什么劫持 `mcpResources.register`：客户端把重试状态关在闭包里（见 `status.js`
 * 的说明），但它在 **apply 一开始** 就会把 `connection.resources` 注册到
 * `mcpResources` 服务上 —— 也就是说，这个注册点同时是：
 *
 *   - **实例的存在性**：注册了 = 实例起来了；dispose 掉了 = 实例没了（激活失败或卸载）；
 *   - **连接的真实状态**：`connection.resources.request` 内部读的是当前的 client，
 *     未连接时会在**发出请求之前**就抛 "server is disconnected"，所以探测它就能拿到
 *     权威答案，而且请求会打到服务器上（不会拿过期缓存糊弄）。
 *
 * 这个接缝对**两种层级都生效**：全局行由 Loader 挂载、项目级条目由本插件挂载，两者
 * 都会走到客户端同一个 `registerServerContext`。工具注册表就做不到这点 —— 项目级的
 * 工具挂在 agent 作用域里，无作用域的 `schemas()` 看不到它们。
 *
 * 手法与 `filter.js` 一致：只写实例、写后**验证**、失败时如实报告原因、可 restore。
 * 区别是这里**不做任何拦截**：原调用照原样转发，我们只是在旁边记一笔（fail-open）。
 */

/** 探测的默认超时：够慢服务器回话，又不至于让一次探测拖住整个 tick。 */
const DEFAULT_PROBE_TIMEOUT_MS = 8000

/** 客户端在未连接时抛出的原文，用它区分「没连上」与「服务器拒绝了这次请求」。 */
const DISCONNECTED_MARKER = 'is disconnected'

/**
 * 装连接监听。
 *
 * @param ctx - 带 `mcpResources` 服务的 cordis 上下文。
 * @param log - `{ warn }`，用于必须上报而不是抛出的路径。
 * @returns `{ installed, reason, has, instances, probe, restore }`。`installed` 为
 *   false 时不要下任何结论 —— 面板会显示「状态未知」，这比猜一个状态诚实。
 */
export function installConnectionWatch(ctx, log) {
  const inert = (reason) => ({
    installed: false,
    reason,
    has: () => false,
    instances: () => [],
    probe: async () => ({ state: 'unknown', detail: reason }),
    restore: () => {},
  })

  let view = null
  try {
    view = ctx.get?.('mcpResources') ?? null
  } catch {
    // 裸访问服务在 cordis 注入之前会抛。
    view = null
  }
  if (view === null || view === undefined || typeof view.register !== 'function') {
    return inert('mcpResources service unavailable')
  }

  // traceable view 的读会转发到它背后的实例，而写必须落在实例上别的读者才看得见。
  const ORIGINAL = Symbol.for('cordis.original')
  let underlying = view
  try {
    const behind = Reflect.get(view, ORIGINAL)
    if (behind !== null && typeof behind === 'object') underlying = behind
  } catch {
    // 没有 traceable 目标：view 本身就是实例。
  }

  let original
  try {
    original = underlying.register
  } catch {
    return inert('mcpResources.register is not readable')
  }
  if (typeof original !== 'function') return inert('mcpResources.register is not a function')

  /** serverName -> 该实例的 provider（`connection.resources`）。 */
  const live = new Map()
  const hadOwn = Object.hasOwn(underlying, 'register')

  const shadowed = function (server, provider) {
    // 原调用先走，且刻意不在 try 里：注册失败（重名等）是服务自己的错误，
    // 吞掉它会把真实冲突变成静默无副作用。
    const dispose = original.call(this, server, provider)
    if (typeof server === 'string' && server !== '') {
      live.set(server, provider)
      if (typeof dispose === 'function') {
        return () => {
          try {
            dispose()
          } finally {
            // 只删自己那一笔：同一名字的实例可能已经被后来者顶替。
            if (live.get(server) === provider) live.delete(server)
          }
        }
      }
      return dispose
    }
    return dispose
  }

  let wrote = false
  try {
    wrote = Reflect.set(underlying, 'register', shadowed)
  } catch (error) {
    return inert(`cannot shadow mcpResources.register: ${String(error?.message ?? error)}`)
  }
  // Reflect.set 在不可写/不可配置上返回 false 且可能静默失败 —— 报告成功却没装上，
  // 正是这类监听最坏的失败方式，所以验证写入而不是假设。
  if (wrote !== true || underlying.register !== shadowed) {
    return inert('mcpResources.register is not writable')
  }

  const restore = () => {
    try {
      if (hadOwn) Reflect.set(underlying, 'register', original)
      else Reflect.deleteProperty(underlying, 'register')
    } catch (error) {
      log?.warn?.(`skills-mcp-panel: could not restore mcpResources: ${String(error?.message ?? error)}`)
    }
    live.clear()
  }

  return {
    installed: true,
    reason: '',
    has: (serverName) => live.has(serverName),
    instances: () => [...live.keys()],
    /**
     * 问一次「现在连着吗」。
     *
     * 判定依据：客户端未连接时会在发出任何请求之前抛 "server is disconnected"，
     * 所以**任何别的回答**（包括服务器回的方法不存在、超时）都说明客户端是活的。
     */
    probe: async (serverName, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) => {
      const provider = live.get(serverName)
      if (provider === undefined || typeof provider.request !== 'function') {
        return { state: 'absent', detail: '' }
      }
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined
      try {
        await provider.request({ method: 'resources/list' }, { signal, timeout: timeoutMs })
        return { state: 'connected', detail: '' }
      } catch (error) {
        const detail = String(error?.message ?? error)
        if (detail.includes(DISCONNECTED_MARKER)) return { state: 'down', detail }
        return { state: 'connected', detail }
      }
    },
    restore,
  }
}
