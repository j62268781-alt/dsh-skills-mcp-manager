/**
 * Section copy: group subtitles and empty states.
 *
 * These strings are user-facing product copy (they tell you which scope you are
 * looking at and what to do next), so they live here with tests pinning them.
 */

/** Subtitle under the global MCP group. */
export function globalMcpSubtitle(rowCount) {
  return `全局 · 配置文件 ${rowCount} 个 · 增删改都会写回 cordis.patch.yml（自动备份）`
}

/** Subtitle under the project MCP group. */
export function projectMcpSubtitle(label, count) {
  return label === ''
    ? '未选择项目 · 面板添加的条目只挂载到该项目内运行的 agent'
    : `${label} · 面板添加 ${count} 个 · 只挂载到该项目内运行的 agent`
}

/** Subtitle under the global skills group. */
export function globalSkillSubtitle(count) {
  return `全局 · ${count} 个 · 写入 $DSH_HOME/skills/`
}

/** Subtitle under the project skills group. */
export function projectSkillSubtitle(label, count) {
  return label === ''
    ? '未选择项目'
    : `${label} · 面板添加 ${count} 个 · 写入 <项目>/.agents/skills/`
}

/** Empty state inside the project MCP group. */
export function emptyMcpText(label) {
  return `${label} 还没有项目级 MCP —— 可以点上面「添加服务器」，或用「导入 MCP」从其他工具导入。`
}

/** Empty state inside the project skills group. */
export function emptySkillText(label) {
  return `${label} 还没有项目级技能。`
}

/** "no search hits" state. */
export function emptySearchText(query) {
  return `没有匹配「${query}」的条目`
}
