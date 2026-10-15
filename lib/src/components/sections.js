/**
 * Section copy: empty states.
 *
 * These strings are user-facing product copy (they tell you what to do next), so they live
 * here with tests pinning them.
 *
 * The per-group subtitles that used to live here (「全局 MCP」/「项目级 MCP」/技能两档) are
 * gone with the groups themselves: both tabs are now one list with one summary line, which
 * is rendered by the panel because its numbers change with the filter.
 */

/**
 * Empty state for the skills list.
 *
 * The list is no longer split per tier, so an empty one means "nothing here at all" when no
 * project is selected. The label keeps the project case specific. A blank label previously
 * produced a sentence starting with a space (` 还没有项目级技能。`), which read as a rendering
 * bug — the branch makes the no-label case its own sentence instead.
 */
export function emptySkillText(label) {
  const name = typeof label === 'string' ? label.trim() : ''
  if (name === '') return '还没有技能 —— 点上面「添加技能」，保存后写入磁盘。'
  return `${name} 还没有技能 —— 点上面「添加技能」，或切到其他工作区。`
}

/** Empty state for the MCP list. */
export function emptyMcpText(label) {
  const name = typeof label === 'string' ? label.trim() : ''
  if (name === '') return '还没有 MCP 服务器 —— 可以点「添加服务器」，或用「导入 MCP」从其他工具导入。'
  return `${name} 还没有 MCP 服务器 —— 可以点「添加服务器」，或用「导入 MCP」从其他工具导入。`
}

/** "no search hits" state. */
export function emptySearchText(query) {
  return `没有匹配「${query}」的条目`
}
