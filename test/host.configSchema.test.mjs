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

test('SkillRequest：结尾必须带 .volatile()（否则队列写入被宿主拒绝）', () => {
  const block = declarationOf('SkillRequest')
  assert.ok(block !== undefined, 'src/index.js 里找不到 const SkillRequest')
  assert.match(block, /\}\)\.default\(\{\}\)\.volatile\(\)/,
    'SkillRequest 缺少 .volatile()：settings.write 会抛 `Config field "skillRequest" is not volatile`，'
    + '而 read（编辑/预览）走的正是队列，症状是「创建正常、编辑读不出正文」')
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
  const names = ['servers', 'skills', 'rowOps', 'skillRequest', 'skillResult', 'profileServers', 'currentWorkspace']
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
