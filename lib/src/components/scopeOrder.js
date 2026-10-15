/**
 * Display order for both tabs (MCP 服务器 / 技能).
 *
 * 两条规则，都只决定「一张卡片出现在哪个位置」，不改变任何条目内容：
 *
 *   1. **全局第一，然后按工作区注册表的顺序**，注册表不认识的作用域（用户手填的路径）
 *      按首次出现的顺序跟在后面。
 *   2. **同一组内保持原数组顺序**。对 MCP 而言那就是配置文件的行顺序，而行顺序就是创建
 *      顺序（新行由 `insertRow` 追加到末尾），所以「新增的排在自己工作区的最后一个」不需要
 *      额外记录；对技能而言是 `config.skills[]` 的顺序，同样由追加决定。只要分组稳定，
 *      这条就自动成立。
 *
 * 这里**不引入分区标题**。面板此前有意去掉了「全局 MCP / 项目级 MCP」两个分区块：两档
 * 只差一个 `scope`，卡片上的作用域标签已经说明了归属。用户要的是顺序（刚加的那个找得到），
 * 不是再加一层标题。技能页签同样如此 —— 两个页签的排序和分组完全一致。
 *
 * 纯函数、不 import React，便于直接单测。
 */

/** 全局作用域的展示键。`''` 与 `'global'` 是同一档，统一成空串。 */
export function scopeKey(scope) {
  if (typeof scope !== 'string' || scope === '' || scope === 'global') return ''
  return scope
}

/**
 * 把条目按展示顺序分组。
 *
 * @param items - 要排序的条目（调用方已完成搜索框过滤）。
 * @param workspacePaths - 工作区路径，**按注册表顺序**；它决定分组顺序。
 * @param pendingScopes - 已在写入但还没有对应条目的作用域。作用域下尚无条目时也保留一个
 *   空组，这样「正在写入」的占位卡片会落在该条目将来出现的位置，而不是跳到列表末尾。
 * @returns `[{ scope, items }]`；全局组的 `scope` 是 `''`。没有任何条目的作用域会被省略
 *   （除非 `pendingScopes` 明确要求）。
 */
export function orderedScopeGroups(items = [], workspacePaths = [], pendingScopes = []) {
  const list = Array.isArray(items) ? items : []
  /** scope -> items，插入顺序 = 调用方给的顺序（MCP: 配置文件行顺序）。 */
  const buckets = new Map()
  /** 首次出现顺序，用于给注册表之外的作用域排序。 */
  const firstSeen = []
  const bucket = (scope) => {
    if (!buckets.has(scope)) {
      buckets.set(scope, [])
      firstSeen.push(scope)
    }
    return buckets.get(scope)
  }

  for (const item of list) bucket(scopeKey(item?.scope)).push(item)
  // 进行中的新增还没有条目，它的作用域否则不会有任何分组。
  for (const scope of Array.isArray(pendingScopes) ? pendingScopes : []) bucket(scopeKey(scope))

  const known = []
  for (const path of Array.isArray(workspacePaths) ? workspacePaths : []) {
    const scope = scopeKey(path)
    if (scope !== '' && !known.includes(scope)) known.push(scope)
  }

  const groups = []
  const taken = new Set()
  // 全局第一，再按工作区注册表顺序，最后补上注册表里没有的作用域。
  for (const scope of ['', ...known, ...firstSeen]) {
    if (taken.has(scope)) continue
    const found = buckets.get(scope)
    if (found === undefined) continue
    taken.add(scope)
    groups.push({ scope, items: found })
  }
  return groups
}
