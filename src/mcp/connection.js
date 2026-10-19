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
  toolCallTimeoutMs: Object.freeze({ min: 1, max: 2147483647 }),
})

/** What the client applies when a field is absent (the form shows these as hints). */
export const CONNECTION_DEFAULTS = Object.freeze({
  failOnStartupError: false,
  initialDelayMs: 500,
  maxDelayMs: 30000,
  maxAttempts: 10,
  toolCallTimeoutMs: 60000,
})

/**
 * The reconnect numbers the form starts from, as strings.
 *
 * Panel field name -> default, so a new server's form opens on the values the client would
 * have applied anyway. Kept beside `CONNECTION_DEFAULTS` so the two cannot drift: these are
 * literally that object, re-keyed into the panel's flat naming.
 */
export const CONNECTION_DRAFT_DEFAULTS = Object.freeze({
  reconnectInitialDelayMs: String(CONNECTION_DEFAULTS.initialDelayMs),
  reconnectMaxDelayMs: String(CONNECTION_DEFAULTS.maxDelayMs),
  reconnectMaxAttempts: String(CONNECTION_DEFAULTS.maxAttempts),
  toolCallTimeoutMs: String(CONNECTION_DEFAULTS.toolCallTimeoutMs),
  /**
   * 明文 token 端点的例外默认为 **false**，与数字字段不同：数字要有「客户端默认值」可以
   * 对齐，而这个开关的默认就是不放宽安全。所以这里放布尔而不是字符串。
   */
  allowInsecureTokenEndpoint: false,
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
 * A blank number means "use the client default", and those defaults are now written
 * **explicitly** rather than omitted: a row with `reconnect: {initialDelayMs: 500, …}` says what
 * it does, while a row with no `reconnect` key depends on a value that lives in another
 * package and can change under it. The panel's form is prefilled with the same numbers
 * (`CONNECTION_DRAFT_DEFAULTS`), so what the user sees and what gets written are the same
 * thing.
 *
 * `failOnStartupError` stays conditional: `false` is the client's default *and* the absence of
 * the key means the same thing, so writing it would only add noise to every row.
 */
/** Parse one top-level config number: blank means "keep the client default". */
function topLevelNumber(value, label) {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  if (text === '') return undefined
  if (!/^\d+$/.test(text)) throw new Error(`${label} 必须是整数（收到「${text}」）`)
  const parsed = Number(text)
  const { min, max } = CONNECTION_BOUNDS[label]
  if (parsed < min || parsed > max) {
    throw new Error(`${label} 必须在 ${min}–${max} 之间（收到「${text}」）`)
  }
  return parsed
}

export function connectionFields(source) {
  const out = {}
  if (source?.failOnStartupError === true) out.failOnStartupError = true
  const reconnect = {}
  for (const [panelField, configField] of Object.entries(RECONNECT_FIELDS)) {
    // `CONNECTION_BOUNDS` is keyed the same way as the config fields, so the default is
    // looked up by the config name and parsed through the same validator as a typed value.
    const parsed = reconnectNumber(source?.[panelField], configField)
      ?? CONNECTION_DEFAULTS[configField]
    reconnect[configField] = parsed
  }
  out.reconnect = reconnect
  /**
   * `toolCallTimeoutMs` is a **top-level** config key (not inside `reconnect`), and it follows
   * the same rule as the reconnect numbers: a value the user set wins, otherwise the client's
   * own default is written explicitly. See `CONNECTION_DRAFT_DEFAULTS` for the matching form
   * prefill — the form and this function have to agree, or the input shows one number while
   * another one is stored.
   */
  const toolCallTimeoutMs = topLevelNumber(source?.toolCallTimeoutMs, 'toolCallTimeoutMs')
    ?? CONNECTION_DEFAULTS.toolCallTimeoutMs
  out.toolCallTimeoutMs = toolCallTimeoutMs
  /**
   * 明文 token 端点的例外：**只在 true 时写入**。
   *
   * 与上面几个数字不同，它没有「客户端默认值」可以对齐：不写这个键就是 `false`，而 `false`
   * 恰恰是我们要的默认。所以省略键而不是写 `false`，让一份没有它的旧配置与新配置文件
   * 逐字相同 —— 也不会在 diff 里凭空多出一行让人以为改了什么。
   */
  if (source?.allowInsecureTokenEndpoint === true) out.allowInsecureTokenEndpoint = true
  return out
}

/**
 * Render a config number back into the panel's flat draft shape.
 *
 * A number the row does not set becomes the client's default rather than a blank, so the form
 * always shows the value that will actually be used. A blank input would say "unset" while the
 * client silently applies 500 — the user could not tell what the row does without reading
 * another package's source. `connectionFields` writes the same numbers, so the form and the
 * file cannot disagree.
 */
export function connectionDraftOf(config) {
  const reconnect = config?.reconnect !== null && typeof config?.reconnect === 'object' ? config.reconnect : {}
  const out = { failOnStartupError: config?.failOnStartupError === true }
  for (const [panelField, configField] of Object.entries(RECONNECT_FIELDS)) {
    const value = reconnect[configField]
    out[panelField] = typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : String(CONNECTION_DEFAULTS[configField])
  }
  // Same rule as the reconnect numbers above: a row that does not set it reads back as the
  // client's default, so the form never shows an empty box for a value that is in force.
  const timeout = config?.toolCallTimeoutMs
  out.toolCallTimeoutMs = typeof timeout === 'number' && Number.isFinite(timeout)
    ? String(timeout)
    : String(CONNECTION_DEFAULTS.toolCallTimeoutMs)
  // 布尔值直接回填：缺失即 false，不需要「默认值」这一层。
  out.allowInsecureTokenEndpoint = config?.allowInsecureTokenEndpoint === true
  return out
}
