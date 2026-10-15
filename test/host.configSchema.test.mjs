/**
 * `Config` 里两个**容易在重构中静默丢失**的声明。
 *
 * ## 为什么是「读源码」而不是「导入 schema」
 *
 * 更理想的断言是读 schema 的元数据（`meta.volatile` / `dict`），但 `src/index.js` 与
 * `dist/index.js` 都 import 宿主的 `@deepseek-ai/schemastery`，而它不在依赖里、只有运行中的
 * app 能解析到 —— 那样的测试在 CI 上直接 `ERR_MODULE_NOT_FOUND`。
 * 冒烟（`scripts/host-smoke.mjs`）**能**导入并确实断言了元数据，但它在 CI 上会跳过
 * （找不到 app 的 node_modules），所以那条护栏在 CI 上是空的。
 *
 * 于是这里用文本断言，专门守「声明有没有被写出来」这件事。它比元数据断言弱，但**它会在 CI 上跑**，
 * 而两个真实事故正是「声明被漏写」：
 *
 *   · `.volatile()` 丢了 → 宿主 `settings.write` 抛
 *     `Config field "skillRequest" is not volatile`；因为 `read` 仍走队列，
 *     症状是「创建正常、编辑读不出正文」；
 *   · `path` 丢了 → 校验把它剥掉，Host 回答「该技能不在当前扫描结果里」。
 *
 * 冒烟里的元数据断言仍是权威版本（它同时覆盖"其它被误删的字段"）；两者互补。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')

/** The `const <name> = z.object({ … })….volatile()` block for one field, or undefined. */
const declarationOf = (name) => {
  const start = source.indexOf(`const ${name} = z.object({`)
  if (start < 0) return undefined
  const end = source.indexOf('\n\n', start)
  return source.slice(start, end < 0 ? undefined : end)
}

test('SkillRequest：Config 字段带 .volatile()，而**校验器那份不带**', () => {
  /**
   * 两个用途需要**不同形态**，混用会出真 bug —— 两者都实际发生过：
   *
   *   · Config 字段要 `.volatile()`，否则 `settings.write` 抛
   *     `Config field "skillRequest" is not volatile`（症状：创建正常、编辑读不出正文）；
   *   · HTTP 路由的**校验器不能** volatile —— 调用一个 volatile schemastery schema 返回 `{}`
   *     而不是校验结果，于是 `scope`/`id` 变 undefined、`writableRoots` 匹配不上，
   *     每次编辑/删除都答「未知的写入区域」。
   *
   * `RowOp`（MCP 路由的校验器）从来不带 `.volatile()`，正是同一个道理。
   */
  const wire = declarationOf('SkillRequest')
  assert.ok(wire !== undefined, 'src/index.js 里找不到 const SkillRequest')
  assert.doesNotMatch(wire, /\.volatile\(\)/,
    'SkillRequest 带上 .volatile() 了：它作为 HTTP 路由的校验器会返回 {}，'
    + '导致 scope/id 丢失、报「未知的写入区域」')

  assert.match(source, /const SkillRequestField = SkillRequest\.default\(\{\}\)\.volatile\(\)/,
    '缺少 SkillRequestField（Config 字段用的 volatile 包装）')
  assert.match(source, /skillRequest: SkillRequestField,/,
    'Config 的 skillRequest 应当引用 SkillRequestField')
})

test('SkillRequest：必须声明 path（read/预览靠它定位 SKILL.md）', () => {
  const block = declarationOf('SkillRequest')
  assert.ok(block !== undefined, 'src/index.js 里找不到 const SkillRequest')
  assert.match(block, /^\s+path: z\.string\(\)/m,
    'SkillRequest 少了 path：客户端 read 请求带的 path 会被校验剥掉，'
    + 'Host 回答「该技能不在当前扫描结果里」')
})

test('SkillRequest：字段集合完整（提取共享 schema 时没有漏项）', () => {
  const block = declarationOf('SkillRequest')
  assert.ok(block !== undefined, 'src/index.js 里找不到 const SkillRequest')
  // 只取对象字面量顶层的 `name: z.…` 行
  const names = [...block.matchAll(/^\s{2}([a-zA-Z]+):\s*z\./gm)].map((m) => m[1]).sort()
  assert.deepEqual(names, [
    'body', 'description', 'id', 'name', 'nonce', 'op', 'path', 'prevName', 'project', 'scope',
  ])
})

test('约定：走设置队列的字段都声明了 .volatile()', () => {
  /**
   * 抽共享 schema 时最容易只修被报的那一个字段。这条钉住的是**约定本身** ——
   * 宿主的 `volatileForm()` 只放行声明为 volatile 的字段，漏一个就少一条可写通道。
   *
   * 字段可能是**内联**的（`rowOps: z.array(RowOp).default([]).volatile()`）或
   * **引用**共享定义的（`skillRequest: SkillRequest`）。引用形态下 `.volatile()` 在定义处，
   * 所以要顺着名字找到定义 —— 早先只截 `Config` 里的那一行，于是把引用误判成"没声明"。
   */
  // `skillRequest` 走引用形态（`SkillRequestField`），它的 `.volatile()` 在包装处 —— 由上面
  // 那条断言单独钉住；这里列的是内联声明的字段。
  const names = ['servers', 'skills', 'rowOps', 'skillResult', 'profileServers', 'currentWorkspace']
  for (const name of names) {
    const at = source.indexOf(`${name}: `)
    assert.ok(at >= 0, `Config 里找不到 ${name}`)
    // 声明可能跨多行（`skillResult: z.object({ … }).volatile()`），所以取到该字段声明结束为止：
    // 下一个同缩进（两空格）的字段名，或 Config 对象的收尾 `})`。
    const rest = source.slice(at)
    const stop = rest.slice(1).search(/\n {2}[a-zA-Z]+: |\n\}\)/)
    const inline = stop < 0 ? rest : rest.slice(0, stop + 1)
    let declaration = inline
    const ref = inline.match(new RegExp(`^${name}:\\s*([A-Z][A-Za-z0-9_]*),?\\s*$`, 'm'))
    if (ref !== null) {
      const block = declarationOf(ref[1])
      assert.ok(block !== undefined, `${name} 引用 ${ref[1]}，但找不到该定义`)
      declaration = block
    }
    assert.match(declaration, /\.volatile\(\)/,
      `${name} 没有声明 .volatile()：宿主会拒绝写入这个字段`)
  }
})
