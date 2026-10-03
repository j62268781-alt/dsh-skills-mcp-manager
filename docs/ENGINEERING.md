# 开发手记（原 README，2026-10-01 ~ 2026-10-03）

> 这是项目开发过程中的**真机验证记录 / 事故复盘 / 踩坑清单**，从 README 里搬过来留档。
> 它是**历史记录**：结论当时都对，但后续迭代让其中一些描述过期了（例如面板后来也会列出
> 磁盘上已有的技能、项目级 MCP 的挂载已经落地、测试数从 80 涨到 140）。
> 想了解插件**当前**的行为，看仓库根目录的 [`README.md`](../README.md)；
> 交付清单与门禁说明见 [`DELIVERY.md`](../DELIVERY.md)。

Settings 里的一个面板：**两个 tab（MCP / Skills）× 两个范围（项目 / 全局）**。
样式与排布照着内置的 **Plugins** 页做（`--dsw-*` token + 卡片/行/操作区），不 import 任何
Harness Client 包，也没有第三方依赖。

> 交付清单、门禁说明与"验证到什么程度（含未验证项）"见 [`DELIVERY.md`](../DELIVERY.md)。

## 它怎么工作

| | 状态存哪 | 谁去落地 |
|---|---|---|
| 面板 UI | 本插件自己的 settings 命名空间（= 行 id `skills-mcp-panel`），经官方 settings remote 读写，落在 profile 的 `cordis.patch.yml` 的 `config.servers` / `config.skills` | Client 半 |
| Skills | 同上 | Host 半把每个启用的条目写成 `<root>/<name>/SKILL.md`：全局 → `$DSH_HOME/skills/`，项目 → `<项目根>/.agents/skills/`；删条目时删除自己写过的文件（清单在 `$DSH_HOME/skills-mcp-panel.state.json`） |
| MCP（全局） | 同上 | Host 半为每个启用的 server 挂一个官方 `@deepseek-ai/dsh-mcp-client` 实例，**挂在根 scope**（`ctx.root`）——工具命名、发现、重连、图片处理与配置行完全一致，且不用改写 profile patch。挂在自己的 fiber 里会让工具被 scope 隔离、agent 看不到，这是真机测出来的 |
| MCP（项目） | 同上 | 监听 `agent/created`：会话工作目录落在某个项目 scope 之内（含子目录）时，把该项目的 server 挂进**这个 agent 自己的 scope**——只有该项目里的 agent 看得到这些工具；`agent/disposed` 时自动卸载 |

改动落盘后 HMR 会重挂本插件，Host 半重新 reconcile。

## 安装（当前是手工装的最小步骤）

```bash
PROFILE=~/.dsh/profiles/desktop
mkdir -p "$PROFILE/node_modules/@local"
cp -R . "$PROFILE/node_modules/@local/dsh-skills-mcp-panel"
# 把 '@local/dsh-skills-mcp-panel' 追加进 package.json 的 dsh.profile.bundles
```

然后用 Creator 模式的 `plugin_manager` 重装一次，让它成为正式安装（写依赖 + 锁文件）。

## 使用

1. 重启/刷新 Web 页面（Client 插件在 boot 时加载）。
2. Settings → **Skills & MCP**。
3. 顶部选范围：**全局**，或选 **项目** 并填项目绝对路径。
4. MCP tab：填 serverName + transport + URL/command → 保存；可停用/删除。
5. Skills tab：填名称/描述/正文 → “保存到磁盘”，Host 半立刻写 `SKILL.md`。

## 样式对齐（v0.2）

排版按 **设置 → 内置插件**（`dsh-client-ui-settings-plugin-inventory`）的官方数值 1:1 复刻：

| 元素 | 官方来源 | 数值 |
|---|---|---|
| 页面头 | plugin-manager `pageHead/Title/Intro` | `padding-top:28px`；标题 20px/500/28px；副标题 13px secondary |
| 标签栏 | — | active = `label-primary` + 2px 下划线，非 active = tertiary |
| 搜索框 | `search` | 高 36px、radius-lg、左侧放大镜、占位色 tertiary |
| 分组头 | inventory `group/groupTitle/groupSub` | 36px 行高 + chevron 切换；副行 12px、`margin:-6px 0 0 20px` |
| 卡片网格 | inventory `cards/card` | `repeat(2,minmax(0,1fr))` + 10px gap；`.5px` 描边 + radius-xl + `settings-card-fill` |
| 卡片内容 | inventory `cardContent/cardMainRow/cardDescription` | `min-height:52px;padding:12px 14px`；标题 14px/500；描述 12px tertiary |
| 展开区 | inventory `cardDetails/details` | 上边框 + `bg-module-platform`，76px 标签列网格 |
| 「已停用」标记 | primitives `Tag.module.css` | radius 999px、`padding:1px 8px`、11px/500、tone=neutral |
| 按钮 | primitives `Button.module.css` | primary → `button-primary-fill/hover`；次级 → outline（`.5px border-l3`）；hover `interactive-bg-hover` |

展开的卡片自动占满整行（`grid-column:1 / -1`），避免把同行的卡片拉出大片空白。

## 自测方式（无需 GUI 权限）

`/tmp/preview/build.py` 用 stub 模块加载器 + React UMD + 从 app 抽出的 403 条 token，
离线渲染 6 个状态（默认 / Skills tab / 展开卡片 / 表单 / 项目范围 / 暗色），
用 headless Chrome 截图后人工比对——改动都是这样迭代出来的。

对运行中的 app 做端到端校验（需要会话 cookie，脚本见本目录 `verify-served.mjs`）：
首页 boot 数据的 combo 列表里应出现 `@local/dsh-skills-mcp-panel/client.js`，
拉取该 combo 应包含 `.smp-page` / `settings.section` / `添加服务器` 等当前版本标记。

## 运行机制（都是真机测出来才对的）

1. **`.volatile()` 改动不会重跑 `apply`**：settings 写入是把值原地塞进运行中的 config，插件不重挂。
   所以 Host 半每 2 秒读一次运行中的 `config.servers.get()` / `config.skills.get()`，只在**值变化**时动作。
2. **动作要连续两次观测一致才执行**：加载器重组时会以"空配置"短暂挂载本行，
   若立刻照做会把在用的 server 全部卸载、把已写出的 SKILL.md 全删掉（真机上确实删过一次）。
3. **MCP 必须挂根 scope**：tools 服务按 scope 解析可见性（`dsh-scope`：scoped 覆盖 global），
   挂在插件自己的 fiber 里，连接正常但 agent 看不到工具。
4. **改 Host 代码要重启 app**：loader 会缓存模块，换 bundle 名字/重挂都不可靠
   （而且临时改包名会让 client bundle 注册不上、整个 Web 启动失败）。Client 半改完刷新页面即可。

## 诊断文件

| 文件 | 用途 |
|---|---|
| `$DSH_HOME/skills-mcp-panel.heartbeat.json` | 每次变化时记录：观测到的 servers/skills、是否变化、挂载数、是否根 scope、上次 reconcile 的写入/删除结果 |
| `$DSH_HOME/skills-mcp-panel.state.json` | 本插件写出的技能文件清单（删条目时据此回收文件） |

两个文件都可以随时删除，会自动重建。

## 真机验证记录（2026-10-01，电脑实操）

用 CDP 驱动真实 app UI（伪造会话 cookie + headless Chrome）走完整流程：

- 面板在真实 Settings 里渲染，排版与「内置插件」页一致（截图留档）
- 新增 MCP 服务器 → profile patch 落盘；删除 → 条目与行一起回收
- 新增全局技能 → `~/.dsh/skills/<名>/SKILL.md`；**该技能随即出现在模型侧技能目录里**
- 新增项目技能 → `<项目>/.agents/skills/<名>/SKILL.md`
- MCP 挂载 → app 出现到 `mcp.deepwiki.com` 的 ESTABLISHED 连接 → **subagent 的工具清单里出现 `mcp__probe-deepwiki__*`** → 删除后连接关闭、`mounted: 0`
- 删除技能 → 文件回收、模型侧技能目录同步消失

## 项目级是怎么判定的

不猜项目根目录，直接用「**配置的 scope 是否为会话 cwd 的目录前缀**」判定：

```
scope = /Users/joeson/Documents/tcl_jiguang
agent cwd = /Users/joeson/Documents/tcl_jiguang/lib/foo   → 命中，挂载
agent cwd = /Users/joeson/Documents/other                 → 不命中
```

技能落盘那边仍按「最近的有 `.git` 的祖先」定位项目根（与 DSH 技能提供方一致）。

## 项目级挂载的真机结论（2026-10-01 实测）

- 心跳里每个命中项目的 agent 各自一条记录（`cwd` + `mounted`），互不共享 → **隔离成立**。
- 工具对 agent 可见：subagent 的工具清单里出现 `mcp__proj-deepwiki__*`。
- **注意延迟**：挂载是「agent 创建时才连接」，连接加发现要几秒，所以新 agent **最开始的一两步**可能还看不到这些工具，
  等连接落定后（实测 20 秒内的后续步骤）就出现了。内置 MCP 行在启动时也要经历同样的连接窗口。
- 运行中增删条目会实时作用于**已经活着**的 agent（新增则挂、删除则卸），实测 `mounted` 随之变化。

## 面板怎么看到「配置文件里已有的 MCP 行」

MCP 行的 Config 没有 `.volatile()` 字段，`pluginInventory.list()` 也不返回 config，
所以客户端拿不到它们的 serverName/url。两条来源叠起来用：

1. **Host 投影（信息最全）**：Host 半从 Loader 读 `@deepseek-ai/dsh-mcp-client` 行，
   把 `{entryId, serverName, transport, target, enabled}` 写进本插件的 settings 命名空间
   （`profileServers` 字段）——settings 是第三方 bundle 唯一能触达客户端的通道。
   只在与已存值不同时才写，避免「写入 → 重挂 → 再写入」；读不到 Loader 时不会擦掉已有投影。
2. **inventory 兜底（无需等 Host）**：客户端直接调 `ctx.remote.pluginInventory.list()`，
   按 `moduleName === '@deepseek-ai/dsh-mcp-client'` 过滤，拿到行 id 与运行阶段
   （`active` / `pending` / `failed`）。Host 投影为空时用它，所以刷新页面就能看到行。

两个坑（都踩过）：

- 访问 `ctx.remote.*` 之前必须把 `remote` 与 `remote.pluginInventory` **都**写进 `inject`，
  否则 apply 抛错 → 整个 Web 启动失败（"1 entry did not activate"）。
- `inventoryMcp` 曾引用定义在其下方的 `debugMcp`，`const` 暂时性死区导致 render 抛错 →
  面板空白但导航还在、控制台未必有栈。**声明顺序在 JS 里是硬约束。**

诊断：面板 URL 加 `?smp=debug` 会多出一个 "Loader 诊断" 分组，列出 Loader 里所有 mcp 相关行。

## 界面结构（v0.3：两层折叠 + 同行筛选栏）

每个 tab 的结构与「内置插件」页一致：

```
[Skills & MCP 页头]
[MCP（n）  Skills（n）]                            ← 标签栏
[🔍 搜索…（占满剩余）      ][项目路径（项目级层）]      ← 同一行的联合筛选
▾ 全局 MCP                        [添加服务器]
    全局 · 面板管理 N 个 · 配置文件 M 个
    [面板管理的卡片] [配置文件行的只读卡片]
▾ 项目级 MCP                      [添加服务器]
    <项目路径> · N 个 · 只挂载到该项目内运行的 agent
    [该项目的卡片]
```

- **两层折叠**：全局 / 项目级各一层，各自可折叠、各有自己的「添加」按钮。
- **联合筛选**：搜索框与项目路径同一行；搜索对当前视图（两层 + 配置文件行）同时生效，
  匹配名称 / 地址 / 描述 / 行 id；项目路径决定「项目级」层显示哪个项目的条目，
  并带 datalist 补全已出现过的项目路径。
- Skills tab 完全同样的布局（全局技能 / 项目级技能 + 同一行筛选）。

## 完整 CRUD（v0.4）

面板现在对**两类条目**都能新增 / 编辑 / 删除：

| | 新增 | 编辑 | 删除 | 启停 |
|---|---|---|---|---|
| 面板添加的条目 | ✓ 层里「添加服务器 / 添加技能」 | ✓ 卡片展开 → 编辑 | ✓ | ✓ MCP 可停用 |
| 配置文件里的行（`mcp-*`） | —（用面板添加替代） | ✓ 写回 profile patch | ✓ 两步确认 | — |

配置行的编辑/删除走 `rowOps` 队列：客户端把 `{op:'delete'|'update', entryId, ...}` 写进本插件的 settings 命名空间
（第三方 bundle 唯一能触达 Host 的通道），Host 半每 2 秒取一次、执行完把队列清空。

写盘安全性（照抄官方 config-editor 的做法）：

- 与 config-editor 共用同一把锁：`withFileLock(join(profileDir,'package.json'))`
- 原子写：`writeFileAtomic`（来自 `@deepseek-ai/dsh-atomic-write`）
- **写前重新解析**：改完先 `parseDocument` 校验一次，YAML 不合法就拒绝写入
- **每次改写前自动备份**：`$DSH_HOME/skills-mcp-panel.backups/cordis.patch.yml.<时间戳>.bak`
- 能定位 `insert:` 列表里的行（你的 4 条就在 `insert:` 里），删空后连空指令一起清掉

**能力门控**：Host 半启动时会写一个 `rowOpsReady: true` 标记；面板只有在看到它时才显示配置行的
编辑/删除按钮——否则旧 Host 会把队列留着，重启后突然执行，等于"点了没反应、之后又生效"。
所以你**必须先重启一次 app**，按钮才会出现。

## 与「内置插件」页的间距对齐（真机量测）

用 CDP 量两侧同一位置的实际像素，逐项对齐（官方 = 设置→内置插件，实测值）：

| 指标 | 官方 | 面板（对齐后） |
|---|---|---|
| 内容左边界 | 532 | **532** |
| 标题/说明 → 标签栏 | 14px | **14px** |
| 标签栏 → 搜索框 | 14px | **14px** |
| 搜索框高 / 圆角 / 左内边距 | 36 / 12px / 36px | **36 / 12px / 36px** |
| 分组标题行高 / 间距 | 36px / 8px | **36px / 8px** |
| 首个分组上边框 | 无 | **无**（`first-of-type`） |
| 卡片网格间距 / 圆角 | 10px / 20px | **10px / 20px** |
| 卡片内容内边距 / 最小高 | 12px 14px / 52px | **12px 14px / 52px** |
| 副行(计数) | 12px/18px, `-6px 0 0 20px` | 同 |

修正过的三处偏差：页面侧边距多加了 48px、块间距用了 24px（官方 14px）、搜索框圆角用了 `radius-lg`(16px)。

按钮区（编辑/删除）用 `--dsw-alias-settings-card-fill` 白底，不再用灰底，也不再显示按钮下方说明文案。

## 配置行 CRUD 的真机验证（2026-10-01）

临时造了一条 `mcp-paneltest`，然后用面板操作：

- **编辑**：面板改 URL → patch 里该行 `url` 变成 `...?edited=2` ✓
- **删除**：两步确认 → 该行连同它的 `insert:` 指令一起从 patch 移除 ✓
- **对比备份**：diff 只有那一条测试行，原有 4 条 MCP 行完好 ✓
- 关键修复：面板拿到的是 loader id（`include:mcp-context7`），而 patch 按裸 id 索引 → 入队时剥掉前缀，Host 侧也做同样容错。

## stdio MCP 的运行环境（真机结论）

DSH 自带运行时 `~/.dsh/dsh-runtimes/<id>/dependencies/`：

| 自带 | 说明 |
|---|---|
| `node/bin/node` | **只带 node**（v24.21.0），`bin/` 里没有 npm/npx |
| `pnpm/bin/pnpm.mjs`、`pnpx.mjs` | pnpm 与它的 npx 等价物 |

所以：

0. **不要给子进程注入 `npm_config_cache`**（我踩过的大坑）：把缓存重定向到私有目录后，
   `npx -y <pkg>` 在 app 的子进程环境里会**静默死亡**——同一个二进制 + 同一个缓存目录，
   在登录 shell 里手跑完全正常，由 Host spawn 就起不来；把这一行去掉，服务立刻启动。
   所以 npm 系命令用用户自己的缓存；若 `~/.npm` 有 root 残留，就 `sudo chown -R $(whoami) ~/.npm`。
1. **`npx …` 类命令优先走自带 runtime**：Host 把它挂成
   `<runtime>/node/bin/node <runtime>/pnpm/bin/pnpx.mjs <包> [参数]`（`-y/--yes` 自动去掉），
   并在子进程 PATH 头部加上 runtime 的 `node/bin`（pnpm 的 bin 垫片内部会 `exec node`，必须能找到）。
   实测最小环境（`env -i HOME=… PATH=/usr/bin:/bin`）下能完成 MCP initialize ✓。
2. **回退路径**（没找到自带 runtime 时）：用登录 shell 解析裸命令 + 注入登录 shell PATH，
   npm 系命令沿用用户自己的 npm 缓存（**不**注入 `npm_config_cache`，原因见上）。
3. 两个环境坑（都踩过）：
   - GUI 启动的 Host，`PATH=/usr/bin:/bin:/usr/sbin:/sbin` → 连 `node` 都没有；
   - `~/.npm` 下可能有 root 所有的文件（以前 `sudo npm`），`npx -y` 会 `EACCES` 挂掉。

## 作用域实测矩阵（2026-10-02，真机）

| 条目 | 作用域 | 主会话 agent（cwd=default-workspace） | subagent |
|---|---|---|---|
| `12306-mcp` | 全局 | ✓ `mcp__12306-mcp__*`（8 个） | ✓ |
| `github` | 全局 | ✓ `mcp__github__*`（26 个） | ✓ |
| `p12306` | 项目 `/…/default-workspace` | ✓（cwd 匹配） | ✗ 只拿 root 作用域工具 |
| `t12306` | 项目 `/…/tcl_jiguang` | ✗ | ✗ |

- 全局条目挂在 `ctx.root` → 所有 agent（含 subagent）都看得到。
- 项目条目挂在 `agent.ctx`（`agent/created` 时按 `agent.session.cwd` 前缀匹配）→ 只对该项目的会话 agent 生效；
  **subagent 是独立 agent，只继承 root 作用域**，所以项目级工具对 subagent 不可见。
- 心跳 `agents` 字段可核对：`[{cwd, mounted}]`。

## stdio 首次启动要等（重要）

`npx`/`pnpx` 首次要把包下载到缓存，这台机器约 1–2 分钟；这期间挂载已建立但工具还没注册，
`tools/list` 完成后面板之外的工具才会出现。心跳 `mounted` 只表示"已挂载"，不代表"已连上"。

排查用的分流探针（临时件，已清理）：脚本里 `env | sort > log` 记录子进程真实环境、
`exec npx "$@"` 保持 stdout 协议流不被污染——**千万不要把 stdout 重定向进日志**，
那等于切断 JSON-RPC 流（我踩过：症状是"进程在跑、工具永远不注册"）。

## 行卡片：改用「模型」页的 item 结构（2026-10-02）

两个 bug 的修复：

1. **标题距顶部对齐**：「内置插件」「模型」的标题都在 `top=161`、18px；我此前多了 28px 的
   `padding-top` 且用了 20px → 现在 `top=161` / 18px，完全一致（实测 CDP）。
2. **item 改用模型页的 rowCard**（`dsh-client-ui-settings-models` 的 `_6fYtdq_row*`，逐条抄数值）：

| 抄自模型页 | 值 |
|---|---|
| rowCard | `border .5px settings-card-stroke`、`bg settings-card-fill`、`radius-xl`、列布局、`gap 12px`、`padding 12px 14px` |
| rowHead | flex、`align-items:center`、`gap:10px` |
| rowIdentity / rowName | inline-flex、`gap:6px`、`min-width:0`；14px/500/22px |
| rowActions | inline-flex、`gap:4px`、`margin-left:auto` |
| 行内按钮 | `height 28px`、`padding 0 10px`、`radius-sm`、12px/18px（删除用红色，同模型页） |

好处正如你所说：**一列布局（不再是两列网格）**，展开区长文本完整换行（`overflow-wrap:anywhere`、
不再 `-webkit-line-clamp:2` 截断），按钮统一到行头右侧、28px 一致。

实测高度：面板条目 54px、配置行 84px（多一行地址）、按钮都在 `.smp-cardHead` 内 ✓。

## pnpm/pnpx 能替代 npx 到什么程度（2026-10-02 实测）

**能，而且已经全线用内置 runtime 了**：`runtime: auto` 把 `npx …` 挂成
`<runtime>/node/bin/node <runtime>/pnpm/bin/pnpx.mjs <包>` ✓，12306 这类包直接可跑。

但遇到依赖冲突的包（例：`@modelcontextprotocol/server-github@2025.4.8`）时：

- 症状：`ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './v3' is not defined by "exports"`
  —— `zod-to-json-schema` 要 `zod/v3`，pnpm 给它的 peer 解析出 **zod 4**；npm 扁平布局用的是父级 zod 3.25 所以没事。
- `dlx` 的**临时安装忽略 overrides**（实测：CWD 的 `pnpm-workspace.yaml` overrides ✗、
  `npm_config_overrides` ✗、`node-linker=hoisted` ✗、`auto-install-peers=false` ✗、`resolution-mode=lowest-direct` ✗，均清过 dlx 缓存）。
- **真实 install 的 overrides 生效** ✓（pnpm 11 把 overrides 放在 `pnpm-workspace.yaml`，不是 package.json）：

```yaml
# $DSH_HOME/mcp-runtime/<name>/pnpm-workspace.yaml
overrides:
  zod: 3.25.76
```

于是「预装模式」= 独立目录 + 内置 pnpm install + 内置 node 直接跑入口文件，完全不碰用户环境：

```
command: <runtime>/node/bin/node
args:    [<DSH_HOME>/mcp-runtime/<name>/node_modules/<pkg>/<bin>.js]
```

当前 github 就是这么配的（`~/.dsh/mcp-runtime/github`，22MB），实测 initialize 通过 ✓。

## 滚动条与条目样式（2026-10-02 修复）

**1. 滚动条必须贴右侧**：面板原来把 `.smp-page` 自己做成了滚动容器（`height:100%; overflow:auto`），
它的右边界是 1096，而设置页外壳 `Dws9Sa_options` 是 1120 → 滚动条内缩 24px ✗。
改成让外壳滚动（`.smp-page` 只做 `width:100%` 的普通流），实测两页的滚动链完全一致：

| | 滚动容器 | 左/右 | 宽 | padding |
|---|---|---|---|---|
| 内置插件 | `Dws9Sa_options` | 508 / **1120** | 612 | `0 24px 24px` |
| Skills & MCP（改后） | `Dws9Sa_options` | 508 / **1120** | 612 | `0 24px 24px` |

**2. 条目统一为 title + subtitle**：所有 MCP/skills 条目（面板添加的、配置文件里的）都是
「头部行 = 标题 + 徽标 + 右侧按钮」+「副标题 = 实际执行的命令/地址」，副标题**常显**、可换行；
展开区只放附加字段。这样不再有"只显示标题、命令要点开才看得到"的条目。

## 全局 MCP 改为配置文件行（2026-10-02）

按「一个来源」的原则，**全局 MCP 现在就是 `cordis.patch.yml` 里的独立 Loader 行**（和 context7 那些完全一样），
面板只是它的前端：

- 列表 = 配置文件行（Host 投影出 serverName/transport/target/args/env ✓）
- 新增 = row op `add`（Host 在第一个 `insert:` 里追加一行，锁 + 写前校验 + 自动备份）
- 编辑 = row op `update`（支持改 args / env）
- 删除 = row op `delete`
- 行里 stdio 的写法保持简洁：`command: npx`、`args: [-y, <包>]`，
  **行内 `env.PATH` = `<runtime>/node/bin:<登录 PATH>`** ← 这是关键：官方 mcp-client 直接 spawn 这些行，
  而桌面版 Host 的 PATH 里没有 node，`npx` 的 `#!/usr/bin/env node` 会直接死。
- **项目级**仍是面板自己挂（官方没有项目级配置层），存在插件 config 的 `servers[]` 里。

⚠️ 已知前提：`command: npx` 走的是**用户自己的 npm 缓存**。`~/.npm` 里若有 root 所有的文件，
需要新下载的包会 EACCES 失败（已缓存的包不受影响）。一次性修复：`sudo chown -R $(whoami):staff ~/.npm`。
不想用 sudo 时，可把该行的 command 换成自带 runtime：
`<runtime>/node/bin/node` + args `[<runtime>/pnpm/bin/pnpx.mjs, <包>]`（github 那种依赖冲突的包反而只能用系统 npx）。

## 表单卡片的间距（2026-10-02）

「添加服务器」表单卡片里 `.smp-cardDetails` 是**唯一子元素**，于是：
`.smp-cardDetails` 的 `border-top` 变成卡片顶部一条多余的横线 ✗，
`.smp-formGrid` 的 `margin-top:10px` 又让上方比下方多 10px ✗。两条规则修掉：

```css
.smp-card>.smp-cardDetails:first-child{border-top:0;padding-top:0}
.smp-formGrid:first-child{margin-top:0}
```

实测：卡片上间距 13px = 下间距 13px，`border-top-width: 0px` ✓。

## MCP 导入：全局 / 项目两个范围（2026-10-02）

不做静默的"自动适配"；改成**显式导入**，两个层级各读各的文件：

| 来源 | 全局（用户级，import 到配置文件行） | 项目级（import 到面板项目条目） |
|---|---|---|
| Claude Code | `~/.claude.json` | `.mcp.json` |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| VS Code | `~/Library/Application Support/Code/User/mcp.json` | `.vscode/mcp.json`（键 `servers`） |
| Gemini CLI | `~/.gemini/settings.json` | `.gemini/settings.json` |
| Qwen Code | `~/.qwen/settings.json` | `.qwen/settings.json` |
| Continue | `~/.continue/config.json` | `.continue/config.json` |
| Crush | `~/.config/crush/crush.json` | `crush.json` / `.crush.json` |
| Zed | `~/.config/zed/settings.json`（`context_servers`） | `.zed/settings.json` |
| opencode | `~/.config/opencode/opencode.json`（`mcp`） | `opencode.json` |
| Codex CLI | `~/.codex/config.toml` ✗ TOML | `.codex/config.toml` ✗ TOML |

- 通道：客户端写 `importRequest{source,scope,project,nonce}` → Host 每 1.5s 检查并扫描 →
  写回 `importResult{files,servers,error}` → 面板预览「哪个文件存在、识别几个、几个形态不支持」→ 确认导入。
- **全局导入**：每个 server 变成一条配置文件行（row op `add`，支持 `headers`）；
  **项目导入**：写进面板项目条目（`scope` = 选中工作区）。
- 表单搜索框只搜**名称**（`搜索名称` / `搜索技能名称`）。

实测（隔离，临时 HOME）：全局 → `~/.claude.json` 1 个、`~/.cursor/mcp.json` 1 个、`~/.config/zed/settings.json` 1 个；
项目 → `.mcp.json` 2 个（headers 透传）、`opencode.json` 1 个（environment 映射）、`.zed/settings.json` 1 个、
`.cursor/mcp.json` 1 个；codex/无用户级文件的 vscode 都给出明确提示。

## 已知边界## 已知边界## 已知边界

- 第三方 bundle 不能注册自己的 `ctx.remote` 命名空间（需要官方仓库的 Typert 代码生成流水线），
  所以数据通道用的是现成的 settings remote —— 这是官方管道，不是绕过。
- 面板只显示“自己管理的条目”；磁盘上由其它工具放进来的 skill 不会列在这里（模型侧照常可见）。
- 项目级 MCP 的挂载在 v1.1；当前会保存配置但不生效。
- 安装/卸载走 profile，第三方 Host 代码在 harness 进程内运行。


---

> **克隆后先构建**：仓库只提交源码 —— `dist/`（Host 半，tsc 产物）与 `lib/client.js`（Client 半，
> esbuild 单文件产物）都在 `.gitignore` 里。因此别人拿到仓库后先跑一次：
>
> ```bash
> npm install
> npm run build      # dist/ + lib/client.js
> npm run deploy     # 会自动先构建（predeploy），再拷贝进 desktop profile（旧版自动备份）
> ```
>
> `npm run gate`（构建 + 测试 + 预览基线）本身也会构建，所以开发时不必手动 build。


## 工程结构（重构后）

插件按 `create-dsh-plugin` 的 `panel` 模板组织：Host 半在 `src/`（tsc → `dist/`），
Client 半在 `lib/src/`（esbuild → 单文件 `lib/client.js`），测试在 `test/` 按接口拆分。

```bash
npm test        # 80 项接口测试（node --test test/）
npm run build   # Host(tsc) + Client(esbuild)
npm run deploy  # 安装进 desktop profile（旧版自动备份）
```

模块职责与本次修复的静默失败清单见 `CHANGELOG.md` 的 0.3.0 一节。


## 重构状态（截至本轮）

已完成：

- **Host 半**：9 个模块（`src/index.js` 只留入口与装配），从 1120 行降到 575 行
- **Client 半**：15 个模块（样式 / CRUD / 组件），`lib/src/client.js` 余 908 行组件主体
- **测试**：21 个 `test/*.test.mjs`，94 项断言全绿（`npm test`）
- **安装脚本**：`npm run deploy`（拷贝式安装 + 旧版自动备份 + 回滚只需改名）
- **仓库**：https://github.com/j62268781-alt/dsh-skills-mcp-panel （tag `v0.3.0` 起）

已知未尽事项：

1. `lib/src/client.js` 仍有约 908 行 React 主体未拆（表单渲染 / 卡片组装 / 状态装配）。
   这三块互相咬合，逐轮小步拆解的收益低于风险，因此暂缓。
2. **安装换代尚未在真机验证**：新布局（`exports["."] → ./dist/index.js`）已在沙箱里
   通过"按 exports 加载 + apply() 正常"的预演，但尚未在真实 app 重启后验收。
   当前 profile 里运行的仍是重构前那份**已验证可用**的版本（回滚点保留）。
   验收方式：`npm run deploy` → 重启 DSH → 检查设置面板可打开、条目数不变、
   增删改/停用/删除弹窗正常、`mcp__*` 工具数不变；异常则把 `.backup-<时间戳>` 改回原名即可。

## 已知的坑（避免重犯）

- 客户端测试的 createElement 替身必须像 React 一样扁平化 children：
  `children.flat(Infinity)`，否则 `node.children[i]` 会拿到 `undefined`。
- 提交前用 `fail` 计数门禁：`npm test | grep "^ℹ fail"` 得到 0 才提交
  （`| grep` 会吞掉退出码，不能只靠 `&&` 串联）。
- 客户端改动后必须跑 `npm run build:client`（esbuild 是客户端唯一的语法闸门）。
- 空 `catch` 会吞掉缺导入这类 ReferenceError，改动时用 `SMP_DEBUG=1` 复现。


## JSX 迁移（已完成）

Client 半已全部改为 JSX：`lib/src/**` 的渲染模块都是 `.jsx`，`lib/src/client.js`（入口与装配）
也就地改用 JSX；`lib/src/client.js` 里不再有 `h(...)` 调用（`grep -c "h('"` = 0）。

规则与验收方式（每一块都照此执行）：

- **就地改写、签名不变、调用点不动**；每块改完必须过 `npm run gate`
  （`build:client` + `npm test` + 离线预览基线：条目 13 / 停用 4 / 删除 5 / tab `MCP（5）|Skills（1）`）
- 不改 profile 安装（全程未做安装换代，运行中的仍是重构前的已验证版本）

已完成清单：

| 文件 | 说明 |
|---|---|
| `lib/src/components/head.jsx` | 页头（样板，确立了全局 jsxFactory 方案）|
| `lib/src/components/tabs.jsx` | tab 条 |
| `lib/src/components/filterRow.jsx` | 搜索框 + 项目选择器 + 自定义路径 |
| `lib/src/components/group.jsx` | 分组标题行 + 副标题 |
| `lib/src/components/dialog.jsx` | 官方 Modal 删除确认 |
| `lib/src/components/card.jsx` | 详情字段表（`detailNodes`）|
| `lib/src/components/chevron.jsx` · `field.jsx` | 小组件 |
| `lib/src/client.js` | `card()` / `profileCard()` / `serverForm()` / `skillForm()` / `importCard()` / `tierSection()` / 四个列表 / 页面根 return / 调试块 —— 全部就地 JSX 化 |
| `lib/src/config.js` · `importSources.js` | 纯逻辑/纯数据（无渲染，无需 JSX）|

无需迁移（纯逻辑，不含渲染）：`components/form.js` · `components/sections.js` · `components/filters.js`。

### JSX 的两条硬约束（踩过坑，务必遵守）

1. **不能 `import 'react'`**：DSH 把 client bundle 当经典脚本求值（官方产物 0 个顶层 import），
   所以 JSX 用全局工厂 `__dshReact.createElement`，由入口 `globalThis.__dshReact = require('react')` 注入；
   测试里对应写 `globalThis.__dshReact = React`（见 `esbuild.config.mjs` 与 `scripts/jsx-hooks.mjs`，两者必须一致）。
2. **测试断言不要用 `React.Children.toArray` 做引用相等**：它会克隆元素并加 key 前缀；
   要比较引用就遍历原始 `props.children`。

## 插件安全边界（2026-10-03，事故后补写）

**规则：绝不允许任何异常逃出这个插件。** 这不是代码风格问题，而是用户配置的安全边界。

原因（DSH 源码 `@deepseek-ai/dsh-app-boot` 里的 `sanitizeProfile`）：

```js
function sanitizeProfile(binName, profileDir, bundles) {
  // "Back up the profile patch and retain only the caller's recovery bundles."
  const backupBase = `${patchPath}.bak-${Date.now()}`
  renameSync(patchPath, backupPath)                    // 整个 cordis.patch.yml 被改名隔离
  writeProfileBundles(profileDir, manifest, bundles)   // 其余插件全部禁用
}
```

也就是说：**插件在加载期或通道处理里抛出一个未捕获异常 → DSH 判定 profile 加载失败 →
把用户整份 `cordis.patch.yml` 改名隔离为 `.bak-<毫秒>`，并禁用所有非恢复插件**
（连带模型提供者一起消失，界面上看起来就是"模型不见了、插件全被禁用"）。

### 事故复盘（已经发生并被修复）

- 症状：应用整体崩溃、退出码 1，日志 `dsh: fatal load failure: ReferenceError: invalidate is not defined`
- 根因：`skillRequest` 处理器里调用了一个**从未定义**的函数 `invalidate()`
- 连带：DSH 的恢复流程隔离了 patch，`llm-pi-ai` 的完整模型列表与 `llm-deepseek` /
  `dsh-context` / `better-sidebar` 等条目从活动文件里消失（**数据一直在 `.bak-<毫秒>` 里**）
- 修复：删掉该调用；处理体包双层 `try/catch`；处理完在同一次写入里清空请求（防止重启重放）

### 为此新增的两道门禁

| 门禁 | 拦住的错误类型 |
|---|---|
| `npm run smoke`（`scripts/host-smoke.mjs`）| 加载/通道期的未捕获异常。按 DSH 的形状真实加载插件，然后依次灌入 `skillRequest`、`importRequest`、一条无法应用的 `rowOps`，断言：无异常逃逸、结果回执、请求被清空、文件真的落盘 |
| `test/patch.apply.lossless.test.mjs` | 改配置行时丢条目/丢注释/丢 `!!js`。危险夹具 + 可选的 `SMP_REAL_PATCH=<真实 cordis.patch.yml>` 在真实文件副本上跑无损检查 |

`npm run gate` = `build:client` + `npm test` + `npm run smoke` + 预览基线，四道全绿才提交。

### 恢复手册（如果又被隔离）

1. 别慌：数据没丢。找 `~/.dsh/profiles/<profile>/cordis.patch.yml.bak-<毫秒>`（DSH 隔离时留下的原始文件）
2. 先把**当前**文件另存一份（`cp cordis.patch.yml cordis.patch.yml.after-crash-<时间>`），不要覆盖任何东西
3. 用备份恢复：`cp cordis.patch.yml.bak-<毫秒> cordis.patch.yml`
4. 检查是否残留会重放的一次性请求：`grep -n "nonce" cordis.patch.yml`，把 `skills-mcp-panel` 段落里的
   `skillRequest` 的 `nonce` 清成 `""`（否则重启会重放同一条请求）
5. 本插件自己的写前备份在 `~/.dsh/skills-mcp-panel.backups/cordis.patch.yml.<ISO 时间戳>.bak`
### 部署闸门（2026-10-03 新增）

`npm run deploy` 在**拷贝之前**先执行一次 `scripts/host-smoke.mjs`（真实加载 + 三通道请求）。
冒烟不通过就打印「已中止部署，profile 未被改动」并以退出码 1 结束 —— **绝不会把一个装上去就崩的
版本拷进 profile**。通过后才走原有的"旧版本备份 + 拷贝"流程。

验证方式（含对照，可复现）：

```bash
# ① 坏构建必须被拦下，且 profile 一字未改
printf '\nthrow new Error("boom")\n' >> src/index.js
mkdir -p /tmp/smp-fake-profile
DSH_PROFILE_DIR=/tmp/smp-fake-profile node scripts/deploy.mjs   # 期望：退出码 1 + 「已中止部署」
ls /tmp/smp-fake-profile/node_modules/@local/dsh-skills-mcp-panel # 期望：不存在
git checkout -- src/index.js

# ② 正常构建应成功
DSH_PROFILE_DIR=/tmp/smp-fake-profile node scripts/deploy.mjs   # 期望：退出码 0 + dist/index.js 就位
rm -rf /tmp/smp-fake-profile
```

顺带核清一条部署环境事实：**profile 的 `node_modules` 里既没有 `yaml` 也没有 `@deepseek-ai/*`**
（`@deepseek-ai` 目录下 0 个包）。插件能加载，是因为 DSH 用自带的 in-memory 解析
（`@deepseek-ai/dsh-app-boot/profile-resolution`）把 `@deepseek-ai/*` 路由到 app 内部。
所以**不要**尝试"部署后就地加载已部署目录"来自检（必然误报），只能在 staging 里验 —— 也就是 smoke 的做法。
