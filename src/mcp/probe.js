/**
 * 探测每个 MCP 服务器的连接状态。
 *
 * 为什么不劫持 `register`：最初的做法是包裹 `mcpResources.register` 来记下每个实例的
 * `connection.resources`，但真机上 `instances` 一直是空的 —— profile 重新组装时
 * `dsh-mcp-resources` 会换成**新的服务实例**，而一次性写下的影子留在旧实例上，之后所有
 * 注册都从旁边走过去了。这类「装上了但收不到东西」的失败最坏：面板会显示得像是正常。
 *
 * 现在改用服务自己的公开方法 `request(server, request, exec)` —— 它内部会按调用者的
 * scope 解析 provider，所以每次调用都重新解析、不受实例更替影响，也不需要劫持任何东西。
 * 三种回答恰好覆盖我们要区分的三种情况：
 *
 *   · 正常返回（或服务器回「方法不支持」这类**别的**错误）→ 客户端活着且连着；
 *   · `server is disconnected` → provider 在，但客户端没连着（未连接）；
 *   · `unavailable in this agent's scope` → 压根没有 provider（没挂载 / 激活失败）。
 *
 * 第二、三种的区分是关键：前者是「连不上」，后者是「实例不在」，两者要给的提示完全不同。
 */

/** 探测默认超时：够慢服务器回话，又不至于拖住整个 tick。 */
const DEFAULT_PROBE_TIMEOUT_MS = 8000

/** 客户端未连接时抛出的原文（见 dsh-mcp-client 的 connection.resources.request）。 */
const DISCONNECTED_MARKER = 'is disconnected'

/** 服务里查不到这个服务器的 provider（见 dsh-mcp-resources 的 request）。 */
const UNAVAILABLE_MARKER = 'is unavailable in this agent'

/** 探测结果取值。 */
export const PROBE_STATE = Object.freeze({
  connected: 'connected',
  down: 'down',
  absent: 'absent',
  unknown: 'unknown',
})

/**
 * 建一个探测器。
 *
 * @param ctx - 带 `mcpResources` 服务的 cordis 上下文。**每次探测都重新解析**该服务，
 *   因为 profile 重新组装会换实例。
 * @param log - `{ warn }`，用于必须上报而不是抛出的路径。
 * @returns `{ available, reason, probe }`。`available()` 为 false 时不要下任何结论 ——
 *   面板会显示「状态未知」，这比猜一个状态诚实。
 */
export function createConnectionProbe(ctx, log) {
  /** 当前的服务实例；解析不到就返回 null。 */
  const resolve = () => {
    try {
      const service = ctx.get?.('mcpResources') ?? null
      if (service === null || service === undefined) return null
      return typeof service.request === 'function' ? service : null
    } catch {
      // 裸访问服务在 cordis 注入之前会抛。
      return null
    }
  }

  return {
    /** 观测机制现在可用吗。 */
    available: () => resolve() !== null,
    reason: () => (resolve() === null ? 'mcpResources service unavailable' : ''),
    /**
     * 问一次「这台服务器现在什么状态」。
     *
     * @param serverName - MCP 服务器名。
     * @param options.agent - 该项目级服务器所在 agent 的 scope；全局行不需要。
     * @param options.timeoutMs - 超时。
     * @returns `{ state, detail }`，`state` 取 {@link PROBE_STATE} 之一。
     */
    probe: async (serverName, options = {}) => {
      const service = resolve()
      if (service === null) return { state: PROBE_STATE.unknown, detail: 'mcpResources service unavailable' }
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined
      try {
        await service.request(serverName, { method: 'resources/list' }, { agent: options.agent, signal, timeout: timeoutMs })
        return { state: PROBE_STATE.connected, detail: '' }
      } catch (error) {
        const detail = String(error?.message ?? error)
        // 顺序有讲究：未连接时客户端在发出请求前就抛，所以这两个标记不会同时出现，
        // 但「unavailable」必须优先判，否则会把「没有 provider」误读成别的东西。
        if (detail.includes(UNAVAILABLE_MARKER)) return { state: PROBE_STATE.absent, detail }
        if (detail.includes(DISCONNECTED_MARKER)) return { state: PROBE_STATE.down, detail }
        // 任何别的回答（方法不支持、超时、协议错误）都说明 provider 存在且请求发出去了
        // —— 客户端未连接时根本走不到这一步。
        log?.warn?.(`dsh-skills-mcp-manager: probe of ${serverName} returned an unexpected error, treating it as connected: ${detail}`)
        return { state: PROBE_STATE.connected, detail }
      }
    },
  }
}
