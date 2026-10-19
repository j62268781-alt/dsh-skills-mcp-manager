/**
 * 直接从 profile patch 文件读 MCP 行。
 *
 * ## 为什么不能只靠 Loader
 *
 * 面板的列表原来从 `loader.entries()` 读 —— 那是 **Loader 的内存注册表**。而 Loader 是通过
 * 文件监听重载 patch 的：写入只要 5ms，但 hmr 的防抖 + 重载插件 + 注册表更新实测要 **4 秒**。
 * 真机时间线：
 *
 *     11:05:25.993  PATCH 写成 3 行        ← HTTP 路由 5ms 就写完了
 *     11:05:26.794  Host rows=2            ← Loader 还没重载
 *     11:05:32.007  rows=3                 ← 6 秒后才收敛
 *
 * 写入一直是快的，慢的是**观察路径**。而这个文件本来就是本插件自己写的（`applyRowOp`），
 * 所以「文件里有什么」我们完全可以直接读。
 *
 * ## 谁是真源
 *
 *   · **文件 = 配置真源**：用户点了保存，行就在文件里，此刻它就是事实；
 *   · **Loader = 运行态真源**：`phase`（fiber 状态）只有 Loader 知道。
 *
 * 所以这里只负责回答「文件里有哪些行」，`phase` 由调用方从 Loader 合并。行进来了但 Loader
 * 还没跟上时，卡片显示「连接中」—— 那是**真的**，不是猜的。
 *
 * ## 边界
 *
 * · 只读，不写；失败一律收敛成 `{ ok: false }`，让调用方回落到 Loader 的视图。
 * · 只取 `name` 为 mcp-client 的行，且跳过带 `group` 的（与其他行语义不同）。
 * · 解析用的自定义 tag 与 `applyRowOp` 完全一致（`!!js`），否则读回来的文档会解析失败。
 */
import { readFile, stat } from 'node:fs/promises'
import { isMap, isSeq, parseDocument } from 'yaml'
import { YAML_JS_TAG } from './apply.js'

/** 与 `applyRowOp` 写入的行模块同名。 */
const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'

/**
 * 把一份 patch 文档里所有 mcp-client 行找出来。
 *
 * @param text - patch 文件全文。
 * @returns 合成后的 entry 数组（形状与 `loader.entries()` 足够像，`serverFromRow` 能直接吃）。
 *   解析失败返回 null，由调用方决定怎么处理。
 */
export function mcpEntriesFromPatchText(text) {
  const document = parseDocument(String(text), { customTags: [YAML_JS_TAG] })
  if (document.errors !== undefined && document.errors.length > 0) return null
  const tops = document.contents
  if (!isSeq(tops)) return null
  const entries = []
  const collect = (row) => {
    if (!isMap(row)) return
    const name = row.get('name')
    if (name !== MCP_MODULE) return
    // 带 `group` 的行是分组路由，不是独立服务器 —— 与 `serverRows` 的过滤保持一致。
    if (row.get('group') !== undefined) return
    const id = row.get('id')
    if (typeof id !== 'string' || id === '') return
    const config = row.get('config')
    entries.push({
      id,
      // 形状对齐 `loader.entries()`：`serverFromRow` 读 `options.name` / `options.config`，
      // `userEnabled` 对全局行读 `entry.disabled`。
      options: { id, name, config: isMap(config) ? config.toJSON() : {} },
      ...(row.get('disabled') === true ? { disabled: true } : {}),
    })
  }
  for (const item of tops.items) {
    if (!isMap(item)) continue
    const insert = item.get('insert')
    if (isSeq(insert)) {
      for (const row of insert.items) collect(row)
      continue
    }
    collect(item)
  }
  return entries
}

/**
 * 读 patch 文件并给出其中的 mcp-client 行。
 *
 * @param path - `cordis.patch.yml` 的绝对路径。
 * @returns `{ ok: true, entries, mtimeMs }` 或 `{ ok: false, reason }`。永不抛错。
 */
export async function readMcpRowsFromPatch(path) {
  try {
    const info = await stat(path)
    const text = await readFile(path, 'utf8')
    const entries = mcpEntriesFromPatchText(text)
    if (entries === null) return { ok: false, reason: 'patch 解析失败' }
    return { ok: true, entries, mtimeMs: info.mtimeMs }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}
