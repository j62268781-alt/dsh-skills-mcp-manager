# 工具清单为什么不该落盘（可行性分析）

> 状态：**已实施路线 A，待发布。** MCP 工具清单、描述、连接状态通过带 Host 连接鉴权的 `GET /dsh-skills-mcp-manager/runtime` 读取，不再写入 settings。旧的三个字段在启动时通过文件锁、备份及原子写清理；仅扫描时间戳变化不会再触发投影写盘。
>
> 面板在 MCP 页签可见时每 5 秒刷新，展开卡片及页面恢复可见时立即读取。接口失败显示明确原因，并撤下旧的连接状态；未提供旧 Host 的 settings 回退，也未增加最后成功清单缓存。工具列表表示当前注册表，断线或未挂载时可能为空。
>
> **以下为实施前的历史调研**，字节数和源码行号反映当时快照，不能视为当前配置的测量值；缓存等建议不代表已经实现。
>
> 相关：[`docs/oauth-feasibility.md`](oauth-feasibility.md)（「需要授权」与点击授权的可行性）。

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| `serverTools` 落盘值吗？ | **34.6%**（3179 / 9176 字节），是本插件写入 patch 的最大单项 |
| `.volatile()` 能阻止落盘吗？ | **不能。** `.volatile()` 的语义是「改完不用重挂」，不是「不持久化」 |
| 真的每 5 秒重写一次吗？ | **是，已实测。** 且根因不是 `serverTools`，是 `discoveryInfo.at` |
| 能完全不落盘吗？ | **能**，走 `webServer` 路由（DSH 官方插件已在用同一套） |
| 要改 `dsh-mcp-client` 吗？ | **不用。** 与 OAuth 那条路不同，这里没有任何私有字段依赖 |
| 顺带能修「断线时清单变空」吗？ | **能**，而且是同一个改动 |

---

## 1. 现状：三个实测数字

```powershell
# 复现：逐字段量化（脚本见 §7）
patch 全文           9176 字节 / 285 行
dsh-skills-mcp-manager 段  6361 字节 / 182 行
```

各字段占全文比例（降序）：

| 字段 | 字节 | 占全文 |
|---|---|---|
| **`serverTools`** | **3179** | **34.6%** |
| `workspaces` | 637 | 6.9% |
| `profileServers` | 623 | 6.8% |
| `discoveryInfo` | 205 | 2.2% |
| 其余 9 个字段合计 | 238 | 2.6% |

5 个工具的描述共 2765 字符，**最长单个 2006 字符**（context7 的 `query-docs`）。
也就是说：**一个工具的描述就占了整个 patch 的 1/5。**

### 1.1 `.volatile()` 不是「不落盘」

这是个容易反着理解的坑，源码写得很明确：

- `dsh-settings/lib/index.js:507` —— `settings.update` **只允许写 volatile 路径**：
  ```js
  for (const path of paths) if (path.length && !isVolatilePath(schema, path))
    throw new Error(`Config field "${path.join(".")}" is not volatile`);
  ```
- `dsh-config-editor/lib/index.js:86-91` —— `edit()` **无条件**读 YAML → 改写 → 写回

所以 `.volatile()` 的准确语义是「**改完不用重挂**」：`cordis-plugin-loader` 在
`lib/index.js:380-382` 检测到「只有 volatile 字段变了」时，直接
`this.fiber._config = this.options.config` 热替换，跳过重挂。

**任何走 `settings.update` 的字段都会落盘 —— volatile 与否无关。**
`serverTools` 是 `.volatile()`（`src/index.js:243-249`），所以它既热生效、又每次落盘。

### 1.2 真正的问题：每 5 秒重写整个文件（已实测）

```powershell
# 复现：观察 mtime
(Get-Item cordis.patch.yml).LastWriteTime      # 00:08:22
Start-Sleep -Seconds 12
(Get-Item cordis.patch.yml).LastWriteTime      # 00:08:32  ← 变了
```

根因**不是** `serverTools`，而是 `discoveryInfo.at`：

```
# 7 秒内两次观察：count 恒为 0，但 at 每次都变
at: 2026-10-13T16:08:47.569Z
at: 2026-10-13T16:08:52.569Z      ← 每 5 秒 scan 一次（src/index.js:1045）
```

因果链（都在 `src/index.js`）：

1. `setInterval(scan, 5000)`（`:1045`）每 5 秒跑一次
2. `scan()` 无条件写 `discoveryInfo = { at: new Date().toISOString(), ... }`（`:1009`）
3. `publish()` 的去重 key 末尾含 `discoveryInfo`（`:1107`）→ **key 每次都不同**
4. `:1108` 的 `if (key === published) return` 因此**永不生效** → 每 5 秒写一次
5. 每次写的内容里都含那 3179 字节的 `serverTools`

**所以「落盘慢」的体感是真的**：`YAML.stringify` 本身只要 2.5ms（实测），但
`edit()` 是「加文件锁 → 读全文件 → 重算条目 → 写回 → 等 Loader reconcile」，
而且**每 5 秒无条件重复**。这与 `src/index.js:1024-1028` 那句注释的意图正好相反
——那里明确写了「recomposition 不能重复写相同的行，否则会触发下一次重载」，
但 `discoveryInfo.at` 让去重彻底失效。

> ⚠️ 附带发现：这个 quirk 意味着 `published` 去重机制**目前是坏的**。
> 它本该是「只在真的变了才写」，实际退化成「每 5 秒必写」。

### 1.3 另一个既有缺陷：断线时清单变空

`toolsByServer()`（`src/mcp/tools.js:55-100`）从活注册表按前缀读。服务器断开时
它的工具被注销，于是返回 `{ ok: true, servers: [{ serverName, tools: [] }] }`
—— **空数组覆盖了上一次的好数据**，卡片显示「暂无已注册的工具」。

实测（`node` 直接调 `toolsByServer`）：

```json
{ "serverName": "down", "tools": [] }     // 读得到，但确实没有工具
```

`{ ok: true, tools: [] }` 是「真实答案」，不是错误 —— 但对面板来说，
「这台服务器没有工具」和「它现在断开所以工具被注销了」是两件事，
后者应该回显**上次已知的**清单并标注状态。

---

## 2. 三条可选路线

| | 路线 A：按需拉取（`webServer` 路由） | 路线 B：内存缓存 + 最小落盘 | 路线 C：只修 churn |
|---|---|---|---|
| `serverTools` 落盘 | **0 字节** | 仍有（可截断） | 34.6%（不变） |
| 每 5 秒重写 | **消除** | 消除 | **消除** |
| 断线回显 | **天然支持** | 支持 | 不支持 |
| 需要 client 侧改动 | 是（加 fetch，约 30-50 行） | 否 | 否 |
| 需要新 inject | `webServer` | 无 | 无 |
| 私有 API 依赖 | 无 | 无 | 无 |
| 工作量 | 中（250-400 行） | 小（80-150 行） | **极小（10-20 行）** |

### 路线 A：`webServer` 路由（推荐）

**核心机制**：插件注册一个 HTTP 路由，面板用 `fetch` 拉工具清单，**完全不经过
settings 文档**，因此一个字节都不落盘。

DSH 里这是**官方在用的模式**，不是偏方：

```js
// dsh-host-open-in-app/lib/index.js:1264-1280 —— 路由 + 鉴权
const rejected = (req, res) => {
  const rejection = connectionOf(ctx).requestRejection(req);
  if (rejection === void 0) return false;
  res.statusCode = rejection; res.end(); return true;
};
ctx.effect(() => ctx.webServer.register({
  kind: "exact", path: "/open-in-app/apps",
  handler: async (req, res) => { if (rejected(req, res)) return; ... }
}), "open-in-app: GET /open-in-app/apps");
```

已核实的事实：

- **服务可注入**：`dsh-host-webserver` 的 `register(route)`（`lib/index.js:177-184`），
  重复 `(kind, path)` 抛错（`:179`）→ 路径必须带插件前缀。
- **鉴权有现成做法**：`connection.requestRejection(req)`
  （`dsh-client-connection/lib/index.js:586-589`）= `isTrustedApiRequest`（查 Host 头是
  loopback / 可信、拒绝 `sec-fetch-site: cross-site`、Origin 必须同源，`:205-221`）
  ＋ `browserAuth.isAuthenticated`（cookie）→ 未通过给 401/403。
  **面板是同一页面同源发请求，天然带 cookie，因此能通过。**
- **插件当前只 inject 了 `loader`**（`src/index.js:53`），要加 `webServer`。
- **client 半目前没有 `fetch` 调用**（`lib/src/client.js` grep `fetch(` = 0 命中），需新增。
  面板的轮询骨架现成（`:293` 700ms / `:297` 1500ms / `:330` 10s），把 `serverTools`
  改成「按需 fetch + 缓存进 state」即可。

**为什么它还顺带修了 §1.3**：Host 侧自己持有「上次已知清单」，断线时照旧返回并带
`stale: true`，面板显示「上次已知（当前未连接）」—— 语义比现在的空数组准确。

**收益量化**：patch 从 9176 → 约 5997 字节（**-34.6%**），且不再有 5 秒周期的
「读全文件 + 加锁 + 重算 + 写回」。

**风险与边界**：

- 路由开在 app 的监听端口上。**只返回工具名与描述**（本来就是要给用户看的），
  不放 env / headers / 凭据。
- 需要处理 Host 未注入 `webServer` 的情况（老 Host / 精简 profile）→ 回退到
  现有 settings 通道，并像 `filterState.reason` 那样**如实报告**为什么用了回退。
- HMR 重载要保证路由 disposer 幂等（`ctx.effect` 已提供）。

### 路线 B：内存缓存 + 最小落盘

保留 settings 通道，但：

1. **不再把 `description` 全量落盘** —— patch 里只留 `{ serverName, tools: [name…] }`，
   描述留在内存、按需通过既有的 `skillRequest` 式通道（`src/index.js:173-190`）取。
   3179 → **245 字节**（实测：只留工具名）。
2. 修掉 `discoveryInfo.at` 的 churn。

**优点**：不动 client 的取数架构，改动小。
**缺点**：描述仍要另开一条按需通道（等于把路线 A 做的事做一半），
且「上次已知」缓存仍需自己维护。

### 路线 C：只修 churn（最小可行）

把 `discoveryInfo.at` 从去重 key 里拿掉（或改成只在 `count`/`roots`/`error` 变化时
才更新 `at`）。**10-20 行**，立刻消除「每 5 秒重写」。

这**不减少** 34.6% 的体积，但把写盘频率从「每 5 秒」降到「真变了才写」——
如果你只想先止血，这是性价比最高的一步。

---

## 3. 建议的顺序

1. **先做路线 C**（10-20 行）—— 立刻止住每 5 秒的写盘，风险极低，且它修的是一个
   独立的真 bug（`published` 去重失效）。
2. **再做路线 A** —— 拿走 34.6% 的体积 + 断线回显。这是正解。
3. 路线 B 不必做（A 已经覆盖它的收益，且不用做两遍）。

## 4. 与 OAuth 那条路的对比（为什么这条值得做）

| | 工具清单落盘（本文） | 点击授权（`oauth-feasibility.md`） |
|---|---|---|
| 依赖私有 API | **无** | 有（`_authProvider` + 未文档化时序） |
| 需要改 `dsh-mcp-client` | 不需要 | 不需要（但靠原型补丁） |
| 依赖能否 import SDK | **不需要 SDK** | ❗ **需要，而插件目前 import 不到**（见下） |
| 收益 | 确定的（-34.6% 体积、消除 5s 写盘） | 取决于目标服务器支持哪种授权 |
| 风险 | 低（官方同款模式） | 高（SDK 升级即失效） |

> **`oauth-feasibility.md` 的补充发现（复核时实测）**：插件
> `package.json` **没有** `dependencies` 字段，`@modelcontextprotocol/client`
> 是 `dsh-mcp-client` 的依赖；从插件目录 `import` 它 → `ERR_MODULE_NOT_FOUND`，
> 且真实 profile 的 `node_modules` 里**根本没有 `@modelcontextprotocol`**。
> DSH 的解析路由只接管 `@deepseek-ai/dsh-*`（`dsh-app-boot/lib/index.js:294`），
> 所以方案 ① 的**第一行 import 就跑不起来** —— 除非先把 SDK 声明成插件依赖并确保
> 它能被解析。这是那条路的第一块多米诺，比原型补丁更靠前。
>
> **本文的路线 A 不受此影响**：它只用 `ctx.webServer`（`@deepseek-ai/*`，由 DSH 路由）
> 和标准 `fetch`，不需要 import 任何 MCP SDK。

## 5. 验收方式（改完怎么证明）

1. `npm run gate`（含真实 Host 装配的 `host-smoke.mjs`）。
2. **新增冒烟断言**：patch 文件在 30 秒内 mtime 不变（现在是每 5 秒变）。
3. **新增断言**：`serverTools` 不再出现在 patch 的 `dsh-skills-mcp-manager` 段里。
4. **新增断言**：断开某台服务器后，面板仍能拿到它的工具清单且带 `stale` 标记。
5. 手动：`Get-Item cordis.patch.yml | % LastWriteTime` 观察 30 秒。

## 6. 未验证 / 留待决策

- 路线 A 的 client 侧取数（`fetch` + 缓存进 React state）未实现，行数是估算。
- 「描述按需取」若走路线 B，需要确认描述长度分布的上限行为（现在最长 2006 字符，
  单条就够撑爆一次按需响应的预期）。
- Host 未注入 `webServer` 时的回退路径未实现（老 Host 场景）。
- 本文只处理 `serverTools`；`workspaces`（6.9%）与 `profileServers`（6.8%）也落盘，
  但它们体积小得多且变化少，不在本次范围。

## 7. 复现脚本

```js
// 逐字段量化 patch 体积
import { readFileSync } from "node:fs"
import YAML from "yaml"
const p = "<profile>/cordis.patch.yml"
const text = readFileSync(p, "utf8")
const doc = YAML.parse(text)
const cfg = doc.find((r) => r && r.id === "dsh-skills-mcp-manager").config
const sizes = Object.keys(cfg)
  .map((k) => [k, Buffer.byteLength(JSON.stringify(cfg[k]))])
  .sort((a, b) => b[1] - a[1])
for (const [k, n] of sizes) console.log(n, k)
```

```powershell
# 观察 5 秒周期的写盘
(Get-Item <profile>\cordis.patch.yml).LastWriteTime
Start-Sleep -Seconds 12
(Get-Item <profile>\cordis.patch.yml).LastWriteTime
```
