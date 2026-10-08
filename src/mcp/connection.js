/**
 * MCP connection-policy fields: `failOnStartupError` plus the `reconnect` block.
 *
 * These are ordinary fields of a `@deepseek-ai/dsh-mcp-client` config, and the
 * plugin has two ways to write one — a profile row edited in the patch file, and
 * a panel-managed server mounted straight into the client. Both paths funnel
 * their numbers through here so the accepted range is defined once.
 *
 * The bounds mirror the client's own zod schema (`Reconnect` in dsh-mcp-client):
 * `initialDelayMs` / `maxDelayMs` are `min(1).max(2147483647)`, `maxAttempts` is
 * an integer `min(1)`. A value outside that range makes the row fail to load, so
 * the panel's text is validated here rather than written on trust.
 */

/** Inclusive bounds the MCP client accepts, per reconnect field. */
export const CONNECTION_BOUNDS = Object.freeze({
  initialDelayMs: Object.freeze({ min: 1, max: 2147483647 }),
  maxDelayMs: Object.freeze({ min: 1, max: 2147483647 }),
  maxAttempts: Object.freeze({ min: 1, max: Number.MAX_SAFE_INTEGER }),
})

/** What the client applies when a field is absent (the form shows these as hints). */
export const CONNECTION_DEFAULTS = Object.freeze({
  failOnStartupError: false,
  initialDelayMs: 500,
  maxDelayMs: 30000,
  maxAttempts: 10,
})

/**
 * Panel field name -> config field name.
 *
 * The panel's draft is flat (one string per input), the config nests the three
 * numbers under `reconnect`.
 */
export const RECONNECT_FIELDS = Object.freeze({
  reconnectInitialDelayMs: 'initialDelayMs',
  reconnectMaxDelayMs: 'maxDelayMs',
  reconnectMaxAttempts: 'maxAttempts',
})

/** Parse one reconnect number: blank means "keep the client default". */
function reconnectNumber(value, field) {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  if (text === '') return undefined
  if (!/^\d+$/.test(text)) throw new Error(`reconnect.${field} 必须是整数（收到「${text}」）`)
  const parsed = Number(text)
  const { min, max } = CONNECTION_BOUNDS[field]
  if (parsed < min || parsed > max) {
    throw new Error(`reconnect.${field} 必须在 ${min}–${max} 之间（收到「${text}」）`)
  }
  return parsed
}

/**
 * The connection fields a panel request carries, as a config fragment.
 *
 * Returns `{}` when nothing is configured, so the client keeps its own defaults
 * and the written YAML stays free of keys that only restate them. `reconnect` is
 * a set: a blank number is omitted, and all three blank omit the whole block.
 */
export function connectionFields(source) {
  const out = {}
  if (source?.failOnStartupError === true) out.failOnStartupError = true
  const reconnect = {}
  for (const [panelField, configField] of Object.entries(RECONNECT_FIELDS)) {
    const parsed = reconnectNumber(source?.[panelField], configField)
    if (parsed !== undefined) reconnect[configField] = parsed
  }
  if (Object.keys(reconnect).length > 0) out.reconnect = reconnect
  return out
}

/** Render a config number back into the panel's flat draft shape. */
export function connectionDraftOf(config) {
  const reconnect = config?.reconnect !== null && typeof config?.reconnect === 'object' ? config.reconnect : {}
  const out = { failOnStartupError: config?.failOnStartupError === true }
  for (const [panelField, configField] of Object.entries(RECONNECT_FIELDS)) {
    const value = reconnect[configField]
    out[panelField] = typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  }
  return out
}
