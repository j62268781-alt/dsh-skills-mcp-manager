/**
 * The import-source picker's options: `[sourceId, label]`.
 *
 * The ids must match the Host's table in src/import/sources.js; labels are the
 * plain tool names shown in the dropdown (no "CLI", no file paths).
 */
export const IMPORT_CHOICES = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
  ['chatgpt', 'ChatGPT'],
  ['cursor', 'Cursor'],
  ['gemini', 'Gemini CLI'],
  ['antigravity', 'Google Antigravity'],
  ['reasonix', 'Reasonix'],
  ['opencode', 'opencode'],
  ['mimocode', 'MimoCode'],
  ['teleagent', 'TeleAgent'],
  ['kilo', 'Kilo Code'],
  ['zcode', 'ZCode'],
  ['grok', 'Grok'],
  ['openclaw', 'OpenClaw'],
  ['pi', 'Pi'],
  ['hermes', 'Hermes'],
  ['kimi', 'KIMI'],
  ['qoder', 'Qoder'],
  ['workbuddy', 'WorkBuddy'],
  ['qwen', 'Qwen'],
  ['continue', 'Continue'],
  ['cline', 'Cline'],
  ['goose', 'goose'],
  ['zed', 'Zed'],
  ['crush', 'Crush'],
]
