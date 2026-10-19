/**
 * mcp/status 接口测试。
 *
 * 这里钉住的是**推导**的正确性，因为它最终会以「重试中 / 已放弃重试」这种确定语气
 * 出现在界面上。几条关键约定：
 *   · 预算必须复刻客户端的退避序列（否则「已放弃」的时机会系统性偏早/偏晚）
 *   · maxAttempts 很大时不能逐次循环（表单允许到安全整数）
 *   · 「该有实例却没有」与「此刻本就不该挂载」必须分开（前者是故障，后者不是）
 *   · 观测机制没装上时给 unknown，不猜
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTH_STATUSES, RECONNECT_DEFAULTS, RECOVERABLE_STATUSES, SERVER_STATUS, SERVER_STATUS_TEXT,
  deriveStatus, reconnectBudgetMs, reconnectPolicy, remainingSeconds,
} from '../src/mcp/status.js'

test('reconnectPolicy：留空/垃圾值回落到客户端默认值', () => {
  assert.deepEqual(reconnectPolicy({}), {
    enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10,
  })
  // 表单里是字符串；YAML 里可能是数字
  assert.equal(reconnectPolicy({ reconnectInitialDelayMs: '1000' }).initialDelayMs, 1000)
  assert.equal(reconnectPolicy({ reconnectInitialDelayMs: 1000 }).initialDelayMs, 1000)
  // 非法值不能被当成配置，否则一行坏数据会让预算算成 0 → 立刻报「已放弃」
  for (const bad of ['', '  ', 'abc', '-5', '0', null, undefined, NaN]) {
    assert.equal(reconnectPolicy({ reconnectInitialDelayMs: bad }).initialDelayMs, 500, `坏值 ${String(bad)}`)
  }
  assert.equal(reconnectPolicy({ reconnectEnabled: false }).enabled, false)
})

test('reconnectBudgetMs：复刻客户端退避序列', () => {
  // 默认：500,1000,2000,4000,8000,16000,30000,30000,30000,30000
  assert.equal(reconnectBudgetMs({}), 500 + 1000 + 2000 + 4000 + 8000 + 16000 + 30000 * 4)
  // 用户那三条项目级条目：initialDelayMs=1000，其余空
  // → 1000,2000,4000,8000,16000,30000,30000,30000,30000,30000 = 181000（约 3 分钟）
  assert.equal(reconnectBudgetMs({ reconnectInitialDelayMs: '1000' }), 1000 + 2000 + 4000 + 8000 + 16000 + 30000 * 5)
  // 关掉重连 = 预算 0
  assert.equal(reconnectBudgetMs({ reconnectEnabled: false }), 0)
  // 触顶后整段求和：不能逐次循环，否则这个会卡住
  const started = Date.now()
  const huge = reconnectBudgetMs({ reconnectMaxAttempts: 100000, reconnectMaxDelayMs: 30000 })
  assert.ok(Date.now() - started < 200, '大 maxAttempts 不该逐次循环')
  assert.equal(huge, 500 + 1000 + 2000 + 4000 + 8000 + 16000 + 30000 * (100000 - 6))
  // maxAttempts=1 → 只有第一次退避
  assert.equal(reconnectBudgetMs({ reconnectMaxAttempts: 1 }), 500)
})

test('deriveStatus：已连接优先于一切', () => {
  assert.equal(deriveStatus({ connected: true, enabled: true, hasInstance: true }), SERVER_STATUS.connected)
  // 就算还没观测到实例，探测说连着就也是连着
  assert.equal(deriveStatus({ connected: true, hasInstance: false }), SERVER_STATUS.connected)
  // 停用的服务器不再探测，标签应是「已停用」而不是「已连接」
  assert.equal(deriveStatus({ connected: true, enabled: false }), SERVER_STATUS.disabled)
})

test('deriveStatus：该有实例却没有 = 激活失败，但要先过宽限期', () => {
  assert.equal(deriveStatus({ connected: false, hasInstance: false, elapsedMs: 0 }), SERVER_STATUS.pending)
  assert.equal(deriveStatus({ connected: false, hasInstance: false, elapsedMs: 60000 }), SERVER_STATUS.failed)
})

test('deriveStatus：本就不该挂载 ≠ 故障', () => {
  // 项目级条目：当前没有该项目的会话，压根没挂 —— 显示「未挂载」
  assert.equal(deriveStatus({ connected: false, expected: false, hasInstance: false, elapsedMs: 600000 }), SERVER_STATUS.unmounted)
  // 但「该挂却没有」仍然是故障
  assert.equal(deriveStatus({ connected: false, expected: true, hasInstance: false, elapsedMs: 600000 }), SERVER_STATUS.failed)
})

test('deriveStatus：实例活着但没连上 —— 按预算区分重试中与已放弃', () => {
  const base = { connected: false, hasInstance: true, budgetMs: 151000 }
  assert.equal(deriveStatus({ ...base, elapsedMs: 1000 }), SERVER_STATUS.retrying)
  assert.equal(deriveStatus({ ...base, elapsedMs: 150999 }), SERVER_STATUS.retrying)
  assert.equal(deriveStatus({ ...base, elapsedMs: 151000 }), SERVER_STATUS.gaveUp)
  assert.equal(deriveStatus({ ...base, elapsedMs: 600000 }), SERVER_STATUS.gaveUp)
  // 重连被关掉：预算 0，不会自己恢复
  assert.equal(deriveStatus({ ...base, budgetMs: 0, elapsedMs: 1 }), SERVER_STATUS.gaveUp)
})

test('deriveStatus：观测机制没装上时如实说未知', () => {
  assert.equal(deriveStatus({ observed: false, connected: null, hasInstance: false }), SERVER_STATUS.unknown)
  assert.equal(deriveStatus({ observed: false, connected: false, hasInstance: true }), SERVER_STATUS.unknown)
})

test('deriveStatus：探测还没结论时给「连接中」，不猜故障', () => {
  // 刚装上、探测还在途中：绝不能给一台正常服务器挂告警
  assert.equal(deriveStatus({ connected: null, hasInstance: true, elapsedMs: 0, budgetMs: 151000 }), SERVER_STATUS.pending)
  // 就算已经等过了预算，只要没有探测结论就仍然不下判断
  assert.equal(deriveStatus({ connected: null, hasInstance: true, elapsedMs: 999999, budgetMs: 1000 }), SERVER_STATUS.pending)
})

test('剩余秒数不为负', () => {
  assert.equal(remainingSeconds(1000, 151000), 150)
  assert.equal(remainingSeconds(999999, 151000), 0)
})

test('deriveStatus：首次连接还在进行中时不能报「激活失败」', () => {
  // 真机上打出来的回归：deepwiki 启动时连接较慢，fiber 处于 LOADING、注册回调还没跑，
  // 于是「观测不到实例」被误判成激活失败 —— 结果一分钟后就 connected 了。
  // 客户端 await 首次连接最久可等到 toolCallTimeoutMs（默认 60s），这期间只能是「连接中」。
  for (const phase of ['loading', 'pending']) {
    assert.equal(
      deriveStatus({ connected: false, hasInstance: false, phase, elapsedMs: 60000, budgetMs: 151500 }),
      SERVER_STATUS.pending,
      `phase=${phase} 不该被报成激活失败`,
    )
    // 权威信号说还在加载，就不许因为「等得久」改口
    assert.equal(
      deriveStatus({ connected: false, hasInstance: false, phase, elapsedMs: 999999, budgetMs: 151500 }),
      SERVER_STATUS.pending,
    )
  }
})

test('deriveStatus：激活失败只由权威 phase 判定', () => {
  assert.equal(
    deriveStatus({ connected: false, hasInstance: false, phase: 'failed', elapsedMs: 1000 }),
    SERVER_STATUS.failed,
  )
  // 反过来：phase 说实例活着（active），即使监听漏了这个实例，也不能升级成「激活失败」——
  // 那会让用户去修一个根本没坏的东西。
  assert.equal(
    deriveStatus({ connected: false, hasInstance: false, phase: 'active', elapsedMs: 600000, budgetMs: 151500 }),
    SERVER_STATUS.gaveUp,
    '监听漏掉实例时不该报激活失败',
  )
  assert.equal(
    deriveStatus({ connected: false, hasInstance: false, phase: 'active', elapsedMs: 1000, budgetMs: 151500 }),
    SERVER_STATUS.retrying,
  )
  // phase 为空（Loader 还没建出 fiber）时，宽限期内仍然不猜
  assert.equal(deriveStatus({ connected: false, hasInstance: false, phase: '', elapsedMs: 5000 }), SERVER_STATUS.pending)
  assert.equal(deriveStatus({ connected: false, hasInstance: false, phase: '', elapsedMs: 60000 }), SERVER_STATUS.failed)
})

test('deriveStatus：需要授权 ≠ 故障，且优先于重试/放弃推导', () => {
  const challenge = { kind: 'required', scope: 'files:read' }
  const base = { connected: false, hasInstance: true, elapsedMs: 1000, budgetMs: 151500 }
  // 未授权时客户端会一路重试到放弃；如果不先判鉴权，界面上就是「已放弃重试」——
  // 把「去授权就好」说成「它坏了」，这正是这个状态要修的那个谎。
  assert.equal(deriveStatus({ ...base, authChallenge: challenge }), SERVER_STATUS.needsAuth)
  assert.equal(
    deriveStatus({ ...base, elapsedMs: 999999, authChallenge: challenge }), SERVER_STATUS.needsAuth,
    '预算耗尽也不该改口成「已放弃重试」',
  )
  // 权威 phase=failed 也不能盖过鉴权挑战：受保护服务器上 failOnStartupError 会让 fiber
  // 直接失败，那是同一个 401 的另一种表现，用户要做的仍然是去授权。
  assert.equal(
    deriveStatus({ ...base, phase: 'failed', authChallenge: challenge }), SERVER_STATUS.needsAuth,
  )
})

test('deriveStatus：已连接优先于鉴权挑战（陈旧 401 不能说健康服务器要授权）', () => {
  // 挑战是**缓存**观测值，连接状态才是当下事实。反过来的话，一台已经连上的服务器
  // 会因为几分钟前的一次 401 被标成「需要授权」，用户会去补一个已经生效的授权。
  assert.equal(
    deriveStatus({ connected: true, hasInstance: true, authChallenge: { kind: 'required' } }),
    SERVER_STATUS.connected,
  )
})

test('deriveStatus：停用与未挂载优先于鉴权挑战', () => {
  const challenge = { kind: 'required' }
  // 停用是你自己的选择，跟授权无关
  assert.equal(deriveStatus({ enabled: false, connected: false, authChallenge: challenge }), SERVER_STATUS.disabled)
  // 项目级条目在没有对应会话时压根没挂载，此时谈授权没有意义
  assert.equal(
    deriveStatus({ connected: false, expected: false, hasInstance: false, authChallenge: challenge }),
    SERVER_STATUS.unmounted,
  )
  // 观测机制没装上时仍然如实说未知，不拿缓存的挑战去猜
  assert.equal(deriveStatus({ observed: false, connected: null, authChallenge: challenge }), SERVER_STATUS.unknown)
})

test('deriveStatus：没有挑战时一切照旧（不能凭空报需要授权）', () => {
  const base = { connected: false, hasInstance: true, elapsedMs: 1000, budgetMs: 151500 }
  for (const authChallenge of [null, undefined]) {
    assert.equal(deriveStatus({ ...base, authChallenge }), SERVER_STATUS.retrying)
    assert.equal(deriveStatus({ ...base, elapsedMs: 999999, authChallenge }), SERVER_STATUS.gaveUp)
  }
})

test('需要授权不算「可重连」状态', () => {
  // 「重连」治不了缺授权：把它放进去会教用户反复点一个无效按钮。
  assert.ok(!RECOVERABLE_STATUSES.includes(SERVER_STATUS.needsAuth))
  assert.deepEqual([...AUTH_STATUSES], [SERVER_STATUS.needsAuth])
  // 每个状态都要有中文标题，否则标签会渲染成 undefined
  for (const value of Object.values(SERVER_STATUS)) {
    assert.equal(typeof SERVER_STATUS_TEXT[value], 'string', `${value} 缺标题`)
    assert.ok(SERVER_STATUS_TEXT[value].length > 0, `${value} 标题为空`)
  }
})

test('deriveStatus：已有凭据时，缓存的 401 不再判为「需要授权」', () => {
  /**
   * 真机现象：明明已经授权（凭据在磁盘上、令牌也有效），卡片却时不时显示「需要授权」。
   *
   * 原因是鉴权挑战是**缓存值**（TTL 两分钟）。服务器不认这份令牌时（比如它的鉴权配置
   * 变了），缓存的 401 会一直把状态钉在「需要授权」上 —— 而用户再点一次授权也不会好。
   * 有凭据却仍 401，说明问题在服务器侧，如实落到「未连接」那几档才对。
   */
  const challenge = { kind: 'required', resourceMetadataUrl: 'http://x/.well-known/oauth-protected-resource' }
  const base = {
    enabled: true, expected: true, observed: true, phase: 'active', hasInstance: true,
    connected: false, elapsedMs: 90_000, budgetMs: 30_000, authChallenge: challenge,
  }
  // 没有凭据：这才是真的需要授权
  assert.equal(deriveStatus({ ...base, hasCredentials: false }), SERVER_STATUS.needsAuth)
  // 有凭据：不该再说「需要授权」，按连接的实际情况给出「已放弃重试」
  assert.equal(deriveStatus({ ...base, hasCredentials: true }), SERVER_STATUS.gaveUp)
  // 缺省也是「没有凭据」——不能让漏传参数变成「永远不提示授权」
  assert.equal(deriveStatus(base), SERVER_STATUS.needsAuth)
})
