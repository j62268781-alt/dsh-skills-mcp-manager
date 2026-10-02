/**
 * Form definitions for servers and skills: labels, hint texts and validation.
 *
 * The hint texts are part of the product copy (they explain the accepted shape
 * of each field), so they live here with tests pinning them.
 */

/** Hint texts, kept in one place because they are user-facing copy. */
export const HINTS = {
  serverName: '例如 context7，最多 32 字符',
  command: 'npx',
  args: '-y @scope/pkg@latest',
  env: 'TEST_TOKEN=sk-xxxxxxx\n多个变量一行一个，例如：\nAPI_KEY=sk-abc\nREGION=cn',
  url: 'https://…/mcp',
  project: '请选择项目',
}

/** Fields of the server form, in render order. */
export function serverFieldDefs() {
  return [
    { key: 'serverName', label: '名称（serverName）', hint: HINTS.serverName },
    { key: 'transport', label: '传输', kind: 'select' },
    { key: 'url', label: 'URL', hint: HINTS.url, when: 'http' },
    { key: 'headers', label: '请求头（KEY: VALUE，每行一个）', kind: 'textarea', when: 'http' },
    { key: 'command', label: '命令', hint: HINTS.command, when: 'stdio' },
    { key: 'args', label: '参数（空格分隔）', hint: HINTS.args, when: 'stdio' },
    { key: 'env', label: '环境变量（KEY=VALUE，每行一个）', hint: HINTS.env, kind: 'textarea', when: 'stdio' },
  ]
}

/** Fields of a skill form. */
export function skillFieldDefs() {
  return [
    { key: 'name', label: '名称', hint: '例如 code-review，最多 64 字符' },
    { key: 'description', label: '描述', hint: '一句话说明这个技能做什么' },
    { key: 'body', label: '正文（Markdown）', kind: 'textarea' },
  ]
}

/** Names accepted for both servers and skills (the Host validates the same shape). */
export function isValidName(name, max = 32) {
  return new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test((name ?? '').trim())
}

/** Validate a server draft; returns a message or null when it may be saved. */
export function validateServerDraft(draft = {}) {
  if (!isValidName(draft.serverName, 32)) return '名称只能用字母、数字、- 和 _，且不超过 32 个字符'
  const transport = draft.transport ?? 'streamable-http'
  if (transport === 'stdio') {
    if ((draft.command ?? '').trim() === '') return 'stdio 传输需要填写命令'
    return null
  }
  if ((draft.url ?? '').trim() === '') return 'http 传输需要填写 URL'
  return null
}

/** Validate a skill draft; returns a message or null. */
export function validateSkillDraft(draft = {}) {
  if (!isValidName(draft.name, 64)) return '名称只能用字母、数字、- 和 _，且不超过 64 个字符'
  if ((draft.body ?? '').trim() === '') return '请填写技能正文'
  return null
}

/** Whether a field applies to the draft's transport. */
export function fieldApplies(field, draft = {}) {
  if (field.when === undefined) return true
  const stdio = (draft.transport ?? 'streamable-http') === 'stdio'
  return field.when === 'stdio' ? stdio : !stdio
}
