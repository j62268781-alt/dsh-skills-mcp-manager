/**
 * MCP 表单的「连接与重连」分组，真的渲染出来并真的进到行操作里。
 *
 * 纯函数测试（crud.servers）只能证明 draft → op 的映射；这里加载真实的客户端
 * bundle 走一遍交互：打开添加服务器 → 填 4 个字段 → 保存，断言写进设置文档的
 * `rowOps` 里带着这些值。编辑已有配置行时还要断言回填。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle, textOf } from '../scripts/lib/client-harness.mjs'

const PROFILE_ROW = {
  entryId: 'include:mcp-existing', serverName: 'existing', transport: 'stdio',
  target: 'npx -y pkg', command: 'npx', args: '-y pkg', env: 'T=1',
  failOnStartupError: true, reconnectInitialDelayMs: '1000', reconnectMaxDelayMs: '60000', reconnectMaxAttempts: '60',
  toolCallTimeoutMs: '60000',
  enabled: true, phase: '',
}

/** 打开“添加服务器”并返回面板助手。 */
function openAddForm(panel) {
  panel.click(panel.byClass('smp-button', '添加服务器'))
  return panel
}

/**
 * 三个 reconnect 数字输入，按渲染顺序（首次延迟 / 最大延迟 / 最大次数）。
 *
 * 不再按 placeholder 找：输入框现在**预填真实默认值**，placeholder 只是同一个数字，
 * 拿它当选择器会把"字段有值"和"字段是空的"混为一谈。
 */
/**
 * The three **reconnect** number inputs, in render order.
 *
 * 按 label 而不是按位置取：表单里还有 `toolCallTimeoutMs` 这个同样是 number 的顶层字段，
 * 而它排在 reconnection 三项**之前**（见 render 顺序）。按位置取会让每次新增字段都悄悄
 * 错位一格 —— 之前就是用一个"取全部 number 输入"的助手，加字段后第一个断言就挂了。
 */
const reconnectInputs = (panel) => panel
  .findAll((node) => node.type === 'input' && node.props.type === 'number')
  .slice(-3)

/** `toolCallTimeoutMs` 的输入框（number 字段里排在重连三项之前的那一个）。 */
const timeoutInput = (panel) => panel
  .findAll((node) => node.type === 'input' && node.props.type === 'number')
  .slice(0, -3)[0]

test('MCP 表单：连接与重连输入**预填真实默认值**，不是空框', { skip: skipWithoutBundle() }, async () => {
  /**
   * 以前这三个框是空的，默认值只写在 placeholder 里（「500（默认）」），落库时又省略键，
   * 由 MCP 客户端补默认值 —— 于是表单显示"未设置"，而 500 其实在生效，且住在别人的包里。
   * 现在表单预填、落库也写，用户看到的和实际生效的是同一组数字。
   */
  const panel = await bootPanel(emptyDoc())
  try {
    openAddForm(panel)
    const numbers = reconnectInputs(panel).map((node) => node.props.value)
    assert.deepEqual(numbers, ['500', '30000', '10'], `三个重连输入应预填默认值：${JSON.stringify(numbers)}`)
    assert.equal(timeoutInput(panel).props.value, '60000', '工具调用超时应预填 60000（PR #1）')

    /**
     * 布尔设置渲染成宿主的 `Switch`（`button[role=switch]`），不再是 `<input type=checkbox>`：
     * 开关同时表达「现在是哪一档」，而勾选框只表达「点了会怎样」。
     * 断言仍要钉住默认值 —— 读 `aria-checked`，那才是开关对外的状态契约。
     */
    const failSwitch = panel.switchNamed('连不上时拒绝激活（failOnStartupError）')
    assert.ok(failSwitch !== null, '缺少 failOnStartupError 开关')
    assert.equal(failSwitch.props['aria-checked'], false, '默认应当关闭（DSH 默认 false）')
    // 第二条安全开关必须在同一张表单里，且默认关闭 —— 它一旦默认打开就是安全降级。
    const insecureSwitch = panel.switchNamed('允许明文 token 端点')
    assert.ok(insecureSwitch !== null, '缺少「允许明文 token 端点」开关')
    assert.equal(insecureSwitch.props['aria-checked'], false, '明文 token 端点默认必须关闭')
  } finally {
    panel.restore()
  }
})

test('MCP 表单：stdio 的「命令」预填 npx', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc())
  try {
    openAddForm(panel)
    panel.change(panel.find((node) => node.type === 'select'), 'stdio')
    const command = panel.find((node) => node.type === 'input' && node.value === undefined
      && node.props.value === 'npx')
    assert.ok(command !== null, '切到 stdio 后「命令」应预填 npx（Host 也会把空命令当 npx）')
  } finally {
    panel.restore()
  }
})

test('MCP 表单：填了连接参数后，命令直接发给 Host（HTTP，不再排进 rowOps）', { skip: skipWithoutBundle() }, async () => {
  /**
   * 命令现在走 `POST /<ns>/rows`：写 patch 只要 1–5ms，而旧的 settings 队列要多等 2–4 秒
   * （500ms 排空轮询 + 固定 1200ms + Loader 重载 + 面板自己 700/1500ms 轮询）。
   *
   * 字段仍逐个断言：换传输不该改变命令的含义。
   */
  const panel = await bootPanel(emptyDoc())
  const { doc, change, byPlaceholder, byText } = panel
  try {
    openAddForm(panel)
    change(byPlaceholder('例如 test，最多 32 字符'), 'github')
    change(byPlaceholder('https://…/mcp'), 'https://example.com/mcp')
    // 每次 change 都会重渲染，旧的节点引用随之失效 —— 所以逐个重新取。
    change(reconnectInputs(panel)[0], '1000')
    change(reconnectInputs(panel)[1], '60000')
    change(reconnectInputs(panel)[2], '60')
    panel.flip('连不上时拒绝激活（failOnStartupError）')
    panel.click(byText('保存'))
    await panel.settle()

    const op = (doc.rowCommands ?? [])[0]
    assert.ok(op, '保存后没有把命令发给 Host')
    assert.equal(op.op, 'add')
    assert.equal(op.serverName, 'github')
    assert.equal(op.failOnStartupError, true)
    assert.equal(op.reconnectInitialDelayMs, '1000')
    assert.equal(op.reconnectMaxDelayMs, '60000')
    assert.equal(op.reconnectMaxAttempts, '60')
    // 走通 HTTP 就**不该**再排队列，否则同一个命令会被执行两次
    assert.deepEqual(doc.rowOps ?? [], [], 'HTTP 成功后不该再写 rowOps')
  } finally {
    panel.restore()
  }
})

test('新增：Host 一确认就摘掉转圈，不等投影（写盘只要几毫秒）', { skip: skipWithoutBundle() }, async () => {
  /**
   * 命令经 HTTP 发出、Host 回 `{ok:true}` 时，写入就已经完成了。此时再显示
   * 「正在写入配置文件…」是在误报"还在写"——它以前要等到**投影**回来（面板下一次
   * 轮询，最长约 1.5 秒）才消失，而那段时间里用户看到的就是"转一会"。
   *
   * 卡片本身要留到投影列出该行为止（否则新增的卡片会先消失、再闪回来），所以这里同时
   * 钉住两件事：转圈没了，卡片还在。
   */
  const panel = await bootPanel(emptyDoc({ profileServers: [], rowOpsReady: true }))
  const cards = () => panel.findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-card'))
    .map((node) => textOf(node).replace(/\s+/g, ' ').trim()).filter((text) => text.includes('brand'))
  try {
    openAddForm(panel)
    panel.change(panel.byPlaceholder('例如 test，最多 32 字符'), 'brand')
    panel.change(panel.byPlaceholder('https://…/mcp'), 'https://brand/mcp')
    panel.click(panel.byText('保存'))

    // 命令还没回来：乐观卡片已在，带转圈（这是诚实的"还在写"）
    assert.equal(cards().length, 1, '保存后应立刻出现乐观卡片')
    assert.match(cards()[0], /正在写入配置文件/, '命令未回时应有转圈')

    // Host 确认 → 转圈必须立刻消失，且卡片仍在
    await panel.settle()
    assert.equal(cards().length, 1, '确认后卡片不该消失（要等投影替换它）')
    assert.doesNotMatch(cards()[0], /正在写入配置文件/, 'Host 已确认，转圈必须摘掉')
  } finally {
    panel.restore()
  }
})

test('MCP 表单：编辑配置行时回填连接参数，且 command 不被 target 污染', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc({ profileServers: [PROFILE_ROW], rowOpsReady: true }))
  const { doc, runtime, byText, find } = panel
  try {
    // 切到 MCP tab（默认就是），点该行的「…」→「编辑」
    panel.openMenu()
    panel.click(byText('编辑'))
    assert.ok(byText('保存到配置行') !== null, '没有进入配置行的编辑态')

    // 回填：三个数字来自行配置；command 是原始可执行文件，不是拼好的 target
    const values = reconnectInputs(panel).map((node) => node.props.value)
    assert.deepEqual(values, ['1000', '60000', '60'], `回填的数字不对：${JSON.stringify(values)}`)
    const commandInput = find((node) => node.type === 'input' && node.props.value === 'npx')
    assert.ok(commandInput !== null, 'command 没有回填成原始命令（可能被 target 污染）')

    // 没动过连接输入框 → op 里必须标记 connectionChanged: false（Host 会跳过它们）
    panel.click(byText('保存到配置行'))
    await panel.settle()
    let op = (doc.rowCommands ?? [])[0]
    assert.ok(op, '没有把命令发给 Host')
    assert.equal(op.op, 'update')
    assert.equal(op.connectionChanged, false, '没改过连接字段却标记成改动，会误删已有配置')
    doc.rowCommands = []

    assert.equal(op.command, 'npx', '保存时 command 被写成了拼好的 target')
    assert.equal(op.args, '-y pkg')
    assert.equal(op.failOnStartupError, true)
    assert.equal(op.reconnectInitialDelayMs, '1000')
    assert.equal(op.reconnectMaxAttempts, '60')
    assert.equal(op.reconnectMaxDelayMs, '60000')
    assert.equal(op.toolCallTimeoutMs, '60000', '顶层超时字段也要随命令带过去（PR #1）')

    // 真改了其中一个数字 → 标记成改动，Host 才会写。
    doc.rowCommands = []
    const settled = find((node) => String(node.props.className ?? '').includes('smp-card') && textOf(node).includes('existing'))
    assert.ok(settled !== null, '保存后找不到该行')
    runtime.render()
    panel.openMenu()
    panel.click(byText('编辑'))
    panel.change(reconnectInputs(panel)[2], '30')
    panel.click(byText('保存到配置行'))
    await panel.settle()
    op = (doc.rowCommands ?? [])[0]
    assert.equal(op.connectionChanged, true, '改了连接字段却没标记，值不会生效')
    assert.equal(op.reconnectMaxAttempts, '30')
    runtime.render()
  } finally {
    panel.restore()
  }
})

test('项目级编辑：回填连接字段，并作为**行操作**写入（不再改 config.servers）', { skip: skipWithoutBundle() }, async () => {
  /**
   * 项目级服务器现在也是 `mcp-client` 行，所以编辑走的是与全局完全相同的行操作管线。
   *
   * 这个用例以前断言「编辑后条目不会被挪到 config.servers 末尾」——那是数组原地替换的
   * 顾虑。行操作按 entryId 定位，本来就不会重排，所以真正的契约变成了两条：
   *   1. 表单要回填已配置的连接策略（空值会被当成「用户清空」而写坏）
   *   2. 保存必须产出一条指向该行的 rowOp，而不是去动插件自己的字段
   */
  const projectRow = (entryId, serverName, over = {}) => ({
    entryId, scope: '/p/tcl', serverName, transport: 'streamable-http',
    target: `http://x/mcp/${serverName}`, command: '', args: '', env: '', headersText: '',
    failOnStartupError: false, reconnectInitialDelayMs: '', reconnectMaxDelayMs: '',
    reconnectMaxAttempts: '', toolCallTimeoutMs: '', enabled: true, phase: 'active', ...over,
  })
  const gitnexus = projectRow('mcp-gitnexus', 'gitnexus', {
    failOnStartupError: true, reconnectInitialDelayMs: '1000', reconnectMaxDelayMs: '60000', reconnectMaxAttempts: '60',
  })
  const figma = projectRow('mcp-framelink-figma', 'framelink-figma')
  const panel = await bootPanel(emptyDoc({
    profileServers: [gitnexus, figma], currentWorkspace: '/p/tcl', rowOpsReady: true,
  }))
  const { doc, findAll, find, byText, change, restore } = panel
  try {
    // 每条都该有「…」触发器（编辑/删除收在里面）。开第一条的菜单再点编辑。
    const triggers = findAll((node) => String(node.props.className ?? '') === 'smp-moreTrigger')
    assert.ok(triggers.length >= 2, `项目级条目没渲染出操作菜单：${triggers.length}`)
    panel.openMenu(0)
    panel.click(byText('编辑'))

    // 回填：必须显示已配置的 1000 / 60000 / 60，而不是空（空会显示成 placeholder 500）
    // number 输入有 4 个（含顶层的 toolCallTimeoutMs），这里只关心重连三项
    const numbers = findAll((node) => node.type === 'input' && node.props.type === 'number')
      .slice(-3).map((n) => n.props.value)
    assert.deepEqual(numbers, ['1000', '60000', '60'], `连接字段没回填：${JSON.stringify(numbers)}`)

    change(reconnectInputs(panel)[0], '2000')
    // 编辑「行」的表单按钮文案是「保存到配置行」——与全局页签完全一致，因为两档同源
    panel.click(byText('保存到配置行'))

    // 契约：一条命令，指向这一行（走 HTTP，见文件头）
    await panel.settle()
    const ops = Array.isArray(doc.rowCommands) ? doc.rowCommands : []
    assert.equal(ops.length, 1, `应恰好发出一条命令：${JSON.stringify(ops)}`)
    assert.equal(ops[0].op, 'update')
    assert.equal(ops[0].entryId, 'mcp-gitnexus')
    assert.equal(ops[0].reconnectInitialDelayMs, '2000')
    assert.equal(ops[0].reconnectMaxAttempts, '60', '没碰的字段被清空了')
    assert.equal(ops[0].failOnStartupError, true, '没碰的勾选框被清空了')
    // 面板自己的配置字段不再是真相源：两档都只写行
    assert.deepEqual(doc.servers ?? [], [], '不该再往 config.servers 写东西')
  } finally {
    restore()
  }
})

test('MCP 表单：两个布尔设置是开关，不是勾选框', { skip: skipWithoutBundle() }, async () => {
  /**
   * 用户反馈：布尔设置用勾选框，且说明文字换行成两行时行距被挤在一起。
   *
   * 两个问题都来自同一处旧样式 `.smp-inlineCheck { height: 32px }` —— 固定高度对一行文字
   * 成立，两行 13px/18px 需要 36px，于是第二行被压在第一行上。这些说明几乎都是整句话，
   * 换行是常态而不是例外，所以固定高度是 bug，不是文字太长。
   *
   * 这条测试钉住**结构**：开关 + 独立文字列 + 独立的后果说明行。具体像素在 CSS 里，
   * 但「说明是不是一个独立元素」决定了它会不会和标题挤成一行 —— 那是可测的。
   */
  const panel = await bootPanel(emptyDoc())
  try {
    openAddForm(panel)
    const rows = panel.findAll((node) => String(node.props.className ?? '') === 'smp-switchRow')
    assert.equal(rows.length, 2, `应有两个开关行，实际 ${rows.length}`)
    for (const row of rows) {
      const classes = (row.children ?? []).flat(3).filter((child) => child?.props).map((child) => String(child.props.className ?? ''))
      assert.ok(classes.some((name) => name === 'smp-switchSlot'), '开关行缺少开关槽位（决定了 flex 布局的是包装器，不是控件本身）')
      assert.ok(classes.some((name) => name === 'smp-switchRowText'), '开关行缺少文字列')
    }
    // 说明文字必须是**独立**的一行：拼进标题里会被当成名称的一部分而跳读。
    const hints = panel.findAll((node) => String(node.props.className ?? '') === 'smp-switchRowHint')
    assert.equal(hints.length, 2, '两条说明应各自是独立元素')
    assert.match(textOf(hints[1]), /明文/, '安全降级的后果说明必须写出来')
  } finally {
    panel.restore()
  }
})

test('MCP 表单：打开明文 token 端点会写进行操作', { skip: skipWithoutBundle() }, async () => {
  /**
   * UI 改了但数据没通是最难发现的一类回归 —— 开关能点、能回填，只是永远不落库。
   *
   * 这条走完整交互：填必填项 → 打开开关 → 保存 → 断言 `allowInsecureTokenEndpoint: true`
   * 真的进了命令。（`connectionChanged` 里手写的字段清单漏一项就会这样，那个清单
   * 在本仓库已经漏过两次。）
   */
  const panel = await bootPanel(emptyDoc({ profileServers: [], rowOpsReady: true }))
  const { doc, change, byPlaceholder } = panel
  try {
    openAddForm(panel)
    change(byPlaceholder('例如 test，最多 32 字符'), 'gitnexus')
    change(byPlaceholder('https://…/mcp'), 'http://sz-00575123-01/mcp/coding')
    const flipped = panel.flip('允许明文 token 端点')
    assert.equal(flipped.props['aria-checked'], true, '翻转后开关状态应当是开')
    panel.click(panel.byText('保存'))
    await panel.settle()

    const op = (doc.rowCommands ?? [])[0]
    assert.ok(op, '保存后没有把命令发给 Host')
    assert.equal(op.allowInsecureTokenEndpoint, true, '明文开关没有写进行操作')
    // 未碰的另一个开关不能被顺手打开 —— 默认值必须仍是关闭。
    assert.notEqual(op.failOnStartupError, true, '没碰的开关被打开了')
  } finally {
    panel.restore()
  }
})
