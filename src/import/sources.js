/**
 * MCP import sources: where each editor keeps its config, and how its entries
 * are shaped. Everything here is pure data plus small pure adapters.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const IMPORT_SOURCES = [
  { id: 'claude', label: 'Claude', project: ['.mcp.json'], global: ['~/.claude.json'], keys: ['mcpServers'] },
  { id: 'codex', label: 'Codex', project: ['.codex/config.toml'], global: ['~/.codex/config.toml'], keys: [], supported: false },
  { id: 'chatgpt', label: 'ChatGPT', project: [], global: [], keys: [] },
  { id: 'cursor', label: 'Cursor', project: ['.cursor/mcp.json'], global: ['~/.cursor/mcp.json'], keys: ['mcpServers'] },
  { id: 'gemini', label: 'Gemini CLI', project: ['.gemini/settings.json'], global: ['~/.gemini/settings.json'], keys: ['mcpServers'] },
  { id: 'antigravity', label: 'Google Antigravity', project: ['.antigravity/mcp.json'], global: [], keys: ['mcpServers'] },
  { id: 'reasonix', label: 'Reasonix', project: [], global: [], keys: [] },
  { id: 'opencode', label: 'opencode', project: ['opencode.json'], global: ['~/.config/opencode/opencode.json'], keys: ['mcp'], shape: 'opencode' },
  { id: 'mimocode', label: 'MimoCode', project: ['.mimo/mcp.json'], global: [], keys: ['mcpServers'] },
  { id: 'teleagent', label: 'TeleAgent', project: [], global: [], keys: [] },
  { id: 'kilo', label: 'Kilo Code', project: [], global: [], keys: ['mcpServers'] },
  { id: 'zcode', label: 'ZCode', project: [], global: [], keys: [] },
  { id: 'grok', label: 'Grok', project: [], global: [], keys: [] },
  { id: 'openclaw', label: 'OpenClaw', project: [], global: [], keys: [] },
  { id: 'pi', label: 'Pi', project: [], global: [], keys: [] },
  { id: 'hermes', label: 'Hermes', project: [], global: [], keys: [] },
  { id: 'kimi', label: 'KIMI', project: ['.kimi/mcp.json'], global: ['~/.kimi/mcp.json'], keys: ['mcpServers'] },
  { id: 'qoder', label: 'Qoder', project: ['.qoder/mcp.json'], global: ['~/.qoder/mcp.json'], keys: ['mcpServers'] },
  { id: 'workbuddy', label: 'WorkBuddy', project: [], global: [], keys: [] },
  { id: 'qwen', label: 'Qwen', project: ['.qwen/settings.json'], global: ['~/.qwen/settings.json'], keys: ['mcpServers'] },
  { id: 'continue', label: 'Continue', project: ['.continue/config.json'], global: ['~/.continue/config.json'], keys: ['mcpServers'] },
  { id: 'cline', label: 'Cline', project: [], global: [], keys: ['mcpServers'] },
  { id: 'goose', label: 'goose', project: [], global: ['~/.config/goose/config.yaml'], keys: [], supported: false },
  { id: 'zed', label: 'Zed', project: ['.zed/settings.json'], global: ['~/.config/zed/settings.json'], keys: ['context_servers'], shape: 'zed' },
  { id: 'crush', label: 'Crush', project: ['crush.json', '.crush.json'], global: ['~/.config/crush/crush.json'], keys: ['mcp'] },
  { id: 'vscode', label: 'VS Code', project: ['.vscode/mcp.json'], global: ['~/Library/Application Support/Code/User/mcp.json'], keys: ['servers', 'mcpServers'] },
]

/** Absolute path for a source entry: `~/…` is user-level, otherwise project-relative. */
export function importFilePath(relative, project) {
  return relative.startsWith('~/') ? join(homedir(), relative.slice(2)) : join(project, relative)
}

/** JSON.parse that tolerates the comments/trailing commas editors allow. */
export function parseJsonLoose(text) {
  const cleaned = String(text)
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(cleaned)
}

/** HTTP headers record -> the panel's KEY=VALUE lines. */
export function headerLines(headers) {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return ''
  return Object.entries(headers).map(([key, value]) => `${key}=${String(value)}`).join('\n')
}

/** Env record -> the panel's KEY=VALUE lines. */
export function envLines(env) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return ''
  return Object.entries(env).map(([key, value]) => `${key}=${String(value)}`).join('\n')
}

/** One tool's entry -> the panel's server shape, or null when unsupported. */
export function adaptImportedEntry(name, spec, shape) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return null
  if (shape === 'zed') {
    const command = spec.command
    if (typeof command === 'string') {
      return { serverName: name, transport: 'stdio', command, args: Array.isArray(spec.args) ? spec.args.map(String) : [], env: envLines(spec.env), url: '', headers: '' }
    }
    if (command !== null && typeof command === 'object' && typeof command.path === 'string') {
      return { serverName: name, transport: 'stdio', command: command.path, args: Array.isArray(command.args) ? command.args.map(String) : [], env: envLines(command.env), url: '', headers: '' }
    }
    if (typeof spec.url === 'string' && spec.url !== '') {
      return { serverName: name, transport: 'streamable-http', url: spec.url, headers: headerLines(spec.headers), command: '', args: [], env: '' }
    }
    return null
  }
  if (shape === 'opencode') {
    if (Array.isArray(spec.command) && spec.command.length > 0) {
      const [command, ...args] = spec.command.map(String)
      return { serverName: name, transport: 'stdio', command, args, env: envLines(spec.environment ?? spec.env), url: '', headers: '' }
    }
    if (typeof spec.url === 'string' && spec.url !== '') {
      return { serverName: name, transport: 'streamable-http', url: spec.url, headers: headerLines(spec.headers), command: '', args: [], env: '' }
    }
    return null
  }
  if (typeof spec.url === 'string' && spec.url !== '') {
    return { serverName: name, transport: 'streamable-http', url: spec.url, headers: headerLines(spec.headers), command: '', args: [], env: '' }
  }
  if (typeof spec.command === 'string' && spec.command !== '') {
    return { serverName: name, transport: 'stdio', command: spec.command, args: Array.isArray(spec.args) ? spec.args.map(String) : [], env: envLines(spec.env), url: '', headers: '' }
  }
  return null
}

/**
 * Scan one tool's project files. Returns what exists, what parsed, what the
 * panel would import (as project-scoped panel entries) and why anything failed.
 */
