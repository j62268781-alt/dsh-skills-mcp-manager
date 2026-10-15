<div align="center">

# dsh-skills-mcp-manager

**在 DSH 的设置面板里管理「技能」与「MCP 服务器」——全局 / 项目级分层，改完即生效**

[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2%20实测-4c6ef5)](#)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/npm%20test-228%20passed-2ea043)](#)
[![runtime deps](https://img.shields.io/badge/运行时依赖-0-8a8f99)](#工作原理)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/j62268781-alt/dsh-skills-mcp-manager)

</div>

---

DSH 插件：把 **Skills** 与 **MCP** 的管理搬进 **设置 → Skills & MCP**。页面是「两个 tab × 两个层级」——MCP 与技能各自分「全局」和「项目级」；卡片、按钮、间距都对齐宿主内置的「内置插件」页，不 import 任何 Harness Client 包。

- 🗂️ **技能**：列表 / 搜索 / 预览全文 / 新建 / 重命名 / 删除，落盘就是 `<技能根>/<名字>/SKILL.md`；删除先备份再删，可手动恢复
- 🔌 **MCP**：全局条目就是 profile `cordis.patch.yml` 里的**真实 Loader 行**，增删改停写回配置文件；项目级条目只挂到该项目里运行的 agent
- 🎛️ **按服务器筛选工具**：展开卡片就能看到这一行**实际注册了哪些工具**（名字 + 描述，来自 harness 自己的工具注册表），并按服务器选择「全部保留 / 只保留勾选 / 只挡勾选」。被挡下的工具**不进工具注册表**，所以也不占用每次组装工具面的 token——实测一个 `chrome-devtools` 就有 30 个工具、约 25 KB schema
- 🚦 **连接状态圆点 + 一键重连**：每张卡片用一个小圆点加一行小字说明状态 —— 🟢`可用 · N 个工具` / 🟡`连接中 · 约 Ns` / 🔴`已放弃重试` / 🔴`异常` / 🟡`需要授权` / ⚪`未挂载`，需要时在 `…` 菜单里点「重连」即可恢复——**不用重启 DSH**。它解决的是一个很坑的场景：DSH 启动时连不上的 MCP，等重试预算用完就**永久失效**（默认只等 151.5 秒），而以前界面上完全看不出来。「需要授权」是其中单列的一种：需要 OAuth 的服务器被拒绝连接**不是故障**（`dsh-mcp-client` 没有 OAuth 支持，401 会被当成网络故障一路重试到放弃），所以它用黄色而不是红色，并说明补授权的办法
- 🎛 **每行一个开关 + `…` 菜单**：启用/停用是小号开关（同时表达当前档位），重连/编辑/删除收在竖向菜单里。停用的行不显示操作，重连只在**启用且确实异常**时出现
- 📥 **MCP 导入**：一键扫描 Claude Code / Cursor / VS Code / Gemini / Codex 等 **26 个来源**的用户级或项目级配置，预览后导入
- 🗂 **一份列表，跨工作区**：全局在前、然后按工作区顺序；卡片上的标签说明它属于谁（「全局」或工作区名）
- 🧯 **不动坏你的配置**：插件里绝不把异常抛出去（DSH 会因此隔离整个 profile 配置），写 `cordis.patch.yml` 前自动备份（只留一个滚动 `.bak`）、写前重新校验
- 📦 **零运行时依赖**：`react` / `yaml` 都用宿主已有的那份，插件本体不带第三方运行时依赖

**目录**：[界面预览](#界面预览) · [安装](#安装) · [使用](#使用) · [工作原理](#工作原理) · [已知边界](#已知边界) · [更多文档](#更多文档) · [License](#license)

## 界面预览

> 两张图都是**用本仓库构建出的客户端 bundle 离线渲染**的（同一套 stub 加载器 + 示例数据），
> 不是真机截图——真机截图会把作者自己的服务器地址与项目路径带进 README。
> 重新生成：`node scripts/screenshots.mjs`。

<p align="center">
  <img src="https://raw.githubusercontent.com/j62268781-alt/dsh-skills-mcp-manager/master/docs/images/mcp-panel.png" width="1000" alt="MCP 面板：全局配置文件行、项目级条目、导入与搜索">
  <br><sub>MCP 面板 · 全局（配置文件行 + 停用/编辑/删除）· 项目级 · 导入 MCP</sub>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/j62268781-alt/dsh-skills-mcp-manager/master/docs/images/tools-filter.png" width="1000" alt="展开卡片：工具清单与「只保留勾选 / 只挡勾选」三档过滤">
  <br><sub>展开卡片 · 这一行注册了哪些工具 + 只保留勾选（未勾的淡化，且不会注册给模型）</sub>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/j62268781-alt/dsh-skills-mcp-manager/master/docs/images/skills-panel.png" width="1000" alt="技能面板：一份列表，按工作区排序，操在 … 菜单里">
  <br><sub>技能面板 · 与 MCP 页签同一套布局 · 全局在前、按工作区排序 · 预览 / 编辑 / 删除 收在 <code>…</code> 菜单</sub>
</p>

## 安装

本插件装进 DSH 的某个 profile（`$DSH_HOME/profiles/<name>`），Host 半在 harness 进程里跑。

### 设置 → 插件市场（推荐）

打开 **设置 → 插件市场**，搜 `dsh-skills-mcp-manager`，点安装，刷新页面即可。

> 桌面端请走市场或内置插件安装器：`desktop` profile 由桌面应用独占，宿主 CLI 的
> `dsh plugin --profile desktop` 会被直接拒绝。

### 命令行

```bash
# npm 包（预构建，安装时不需要编译）
dsh plugin --profile web add @j62268781-alt/dsh-skills-mcp-manager

# 或 GitHub Release 上的预构建 tarball（链接恒定指向最新版）
dsh plugin --profile web add https://github.com/j62268781-alt/dsh-skills-mcp-manager/releases/latest/download/j62268781-alt-dsh-skills-mcp-manager.tgz
```

**重启 DSH**，再刷新页面：**设置 → Skills & MCP**。

卸载：

```bash
dsh plugin --profile web remove @j62268781-alt/dsh-skills-mcp-manager
```

### 从源码（开发）

```bash
git clone https://github.com/j62268781-alt/dsh-skills-mcp-manager.git
cd dsh-skills-mcp-manager
npm install
npm run build      # dist/（Host，tsc）+ lib/client.js（Client，esbuild 单文件）
npm run deploy     # 拷贝进 profile；部署前先跑加载冒烟，失败则 profile 一字不动
```

`npm run deploy` 的目标是 `$DSH_HOME/profiles/desktop/node_modules/@j62268781-alt/dsh-skills-mcp-manager`，
旧版本备份成同级的 `.backup-<时间戳>`（回滚只需改名回来）。仓库**不提交构建产物**，所以克隆后必须先 build。

之后把包名挂进 profile 的 bundles 并重启：

```jsonc
// $DSH_HOME/profiles/desktop/package.json
{ "dsh": { "profile": { "bundles": [ /* … */ "@j62268781-alt/dsh-skills-mcp-manager" ] } } }
```

## 使用

入口：**设置 → Skills & MCP**（与内置插件页同一套设置槽位）。

- **搜索**只匹配名称，**不**匹配地址 / 参数 / 环境变量
- **一份列表**，没有分区标题：全局的排前面，然后按工作区顺序；卡片上的标签说明它属于谁
- **「添加」按钮与搜索框同一行**，表单紧贴列表上方（点完就能看到它要追加到的位置）
- **没有项目筛选器**：列表跨工作区展示（全局在前，然后按工作区顺序），卡片上的标签说明归属。
  新条目要写到哪个工作区，在添加对话框里选
- **卡片标签统一**：全局显示「全局」，项目级显示工作区名 —— MCP 与 Skills 同一套词表
- **卡片操作收进 `…` 菜单**（预览 / 编辑 / 删除），只有启用开关留在卡片上

### MCP

| | 全局 MCP | 项目级 MCP |
|---|---|---|
| 存在哪 | profile `cordis.patch.yml` 的 Loader 行 | 插件自己的 settings 字段 `servers[]` |
| 谁去连接 | 官方 `@deepseek-ai/dsh-mcp-client` 直接加载这些行 | 插件在 `agent/created` 时按项目路径挂载 |
| 生效范围 | 所有会话（含 subagent） | 只有该项目里运行的会话 agent |
| 增删改 | 写回配置文件（加锁 + 原子写 + 写前校验 + 自动备份） | 写进 settings 文档 |

- 卡片上的「配置文件」标签表示这一行来自 `cordis.patch.yml`；这种行可以**编辑 / 停用 / 删除**，改动通过带鉴权的 `POST /dsh-skills-mcp-manager/rows` **立即**写回（新增/删除在点击瞬间就生效，不等轮询）
- 展开卡片能看传输方式、地址或命令、参数、环境变量（值打码）、范围与启停状态
- **展开卡片的「工具」一栏可以只保留你需要的工具**。每个服务器的工具清单下面有三档：
  | 档位 | 含义 |
  |---|---|
  | 全部保留（默认） | 不做任何干预，该服务器列出的工具全部注册 |
  | 只保留勾选 | 勾选的才注册，没勾的**不会进入工具注册表**（也不占 token） |
  | 只挡勾选 | 勾选的被挡住，其余照常注册 |

  被挡下的工具不只是「不显示」——它们从未注册，所以也不占用每次组装工具面的 JSON schema 体积。
  实测本机 chrome-devtools 一个服务器就占 30 个工具、约 25 KB（≈5.8k tokens），
  只留常用的几个收益很明显。

  两点如实说明：
  - **改动要等该服务器重新注册工具时才完全生效**。规则本身是**即时**读取的（改完保存即可，
    不用重启），但已经注册进注册表的工具无法被插件注销，所以已存在的工具不会当场消失。
    想立刻看到效果：把这张卡片**「停用」再「启用」**（几秒即可）——停用会销毁该服务器的桥接、
    连带注销它的工具，启用时重新连接并重新注册，于是全部工具重新过一遍过滤；或者重启 DSH。
  - 过滤靠劫持工具服务的 `register` 实现——因为 `dsh-mcp-client` 自身没有白名单字段，
    而 `ctx.tools.restrict()` 要求 scoped 上下文（全局调用会抛错）、且只遮罩不注销。
    这是唯一能真正把工具挡在注册表外的接缝。装不上时面板会显示原因，而不是假装在工作。
- **停用只是把该行的 `enabled` 置 false，不删你的配置**
- **连接与重连**（添加/编辑 MCP 时的最后一组输入，全局与项目级都支持）：直接对应 `@deepseek-ai/dsh-mcp-client` 自己的配置字段
  | 表单里填的 | 落到 config 的 | 默认值 | 作用 |
  |---|---|---|---|
  | 连不上时拒绝激活 | `failOnStartupError` | `false` | 勾上后：首次连接或工具同步失败会让插件激活失败（不勾则照常启动，只是没有该服务器的工具） |
  | 工具调用超时（ms） | `toolCallTimeoutMs` | `60000` | 单次 `tools/call` 的超时。导入/分析这类**分钟级**操作会被默认 60 秒打断（本机实测一次 Ghidra 导入+全量分析约 **158 秒**），按需调大 |
  | 重连首次延迟（ms） | `reconnect.initialDelayMs` | `500` | 第一次重连等待多久，之后逐次翻倍 |
  | 重连最大延迟（ms） | `reconnect.maxDelayMs` | `30000` | 退避延迟的上限 |
  | 重连最大次数 | `reconnect.maxAttempts` | `10` | 单次断线最多连续尝试几次，超出则放弃 |
  **输入框预填真实默认值，落库也写成显式值**（`500 / 30000 / 10`）：表单显示的就是实际生效的，
  不用去翻 `dsh-mcp-client` 的源码才知道这一行怎么重连。清空输入框会回到默认值，而不是删掉键。
  `failOnStartupError` 例外——`false` 与「键不存在」完全等价，写它只是噪音，所以只在勾选时写入。
  填了非法值（非整数、超范围）会被拒绝并提示——因为写进去会让整行加载失败
- **导入 MCP**：选来源 → 扫描 → 预览「哪些文件存在、识别出几个、几个形态不支持」→ 确认。全局导入写成配置文件行，项目导入写进面板的项目级条目

### 技能

- 列表 = **磁盘扫描结果**：`$DSH_HOME/skills`、`~/.agents/skills`、以及各项目的 `.agents/skills` / `.dsh/skills`；卡片上的 `dsh` / `agents` 标签表示它来自哪个根（早期版本写进 `config.skills[]` 的条目也会列出来，并被镜像到对应根）
- 「添加技能」写入 `<根>/<名字>/SKILL.md`：区域选全局或项目，**名字同时是目录名**
- 预览按需读取文件正文（4KB 上限，正文不进设置文档，设置文件不会越用越大）
- 重命名会**同时移动目录并改写 frontmatter 里的 `name`**（否则面板和文件夹会对不上）
- 删除是两步确认：先把目录备份到同级的 `.smp-backup-<名字>-<毫秒>`，再删除；备份会保留，需要时手动改回原名即可

### 状态与失败

在途操作在**卡片上**显示进度（`保存中…` / `删除中…` / `切换中…`），期间该卡片的其它按钮不可点；操作失败会就地显示原因（例如「该技能不在当前扫描结果里」）。删除若 15 秒没有回执，会停止转圈并提示重试。

## 工作原理

插件分两半，装在同一个包里：

```
src/**        Host 半（tsc → dist/index.js）       跑在 harness 进程
lib/src/**    Client 半（esbuild → lib/client.js） 跑在浏览器，单文件、CSS 内联
cordis.patch.yml                                   声明插件行（本包自己的 bundle patch）
```

**数据通道**：MCP 工具清单、描述及连接状态通过只读 `GET /dsh-skills-mcp-manager/runtime` 获取，复用 Host 的 `connection.requestRejection()` 鉴权，响应禁用缓存。面板打开 MCP 页签、展开卡片及页面恢复可见时读取，可见期间每 5 秒刷新；切换页签或卸载时取消请求。读取失败会显示原因并清除旧连接状态，不回退到 YAML 快照。清单只反映当前注册的工具，断开或未挂载时可能为空。

**命名与升级**：插件行 id、settings 命名空间和运行时接口前缀统一为 `dsh-skills-mcp-manager`。启动时将旧配置行改为新 id，保留连接参数、技能和过滤规则；首次读取技能归属清单时导入旧文件，后续以新文件为准。**升级前请读 [`docs/MIGRATION-0.5.5.md`](docs/MIGRATION-0.5.5.md)** —— 这一版改动了「数据存在哪里」（插件身份、MCP 配置单源化、行操作换传输），迁移全部自动完成，但需要重启一次 DSH。

**配置持久化**：服务器连接参数、`toolFilters` 和现有操作通道仍通过官方 settings remote 管理；`profileServers`、`discoveredSkills`、`filterState`、`probeState` 等投影暂保留原通道。启动时使用配置文件锁、备份和原子写清理本插件行里的旧 `serverTools`、`serverToolsError`、`serverStatus`。扫描时间戳不参与投影去重，因此仅扫描时间变化不会触发 settings 写入。

**技能**：面板写的、导入的、手工放进根目录的，最终都以磁盘文件为准。Host 每 2 秒读一次运行中的 `config.skills[]`，把每个条目对账成 `<根>/<名字>/SKILL.md`，并回收自己之前写过、现在不该存在的文件（清单在 `$DSH_HOME/dsh-skills-mcp-manager.state.json`）。默认技能根与 DSH 自带的文件技能提供方一致。

**项目级 MCP**：不猜项目根——用「配置里的 scope 是否为会话 cwd 的**目录前缀**」判定，命中的 agent 才挂载，`agent/disposed` 时卸载。注意 **subagent 是独立 agent，只继承 root 作用域**，所以项目级工具对 subagent 不可见（全局工具两处都可见）。

**全局 MCP**：对 `cordis.patch.yml` 的写入照抄官方 config-editor 的做法——同一把文件锁、原子写、写前重新 `parseDocument` 校验、每次改写前自动备份，块外的用户内容逐字节保留（注释、`!!js` 表达式都不会被写坏）。

**备份只留一个文件**：改写前把当前内容写到 `$DSH_HOME/dsh-skills-mcp-manager.backups/cordis.patch.yml.bak`，
每次覆盖。它保存的是「**当前状态之前的那一份**」，也就是**撤销上一次操作**——这也是它唯一的用途，
所以不留带时间戳的历史副本（早先那样做，一天就堆了 135 个文件、其中 130 个是逐字节重复）。
需要长期历史请用版本控制。

**安全边界**：DSH 的 `sanitizeProfile` 会在**插件加载或通道处理抛出未捕获异常**时，把用户整份 `cordis.patch.yml` 改名隔离并禁用其它插件。所以本插件的每个通道处理都包了双层 `try/catch`：宁可回一条失败原因，也不让异常逃出去。

**工具过滤**：`dsh-mcp-client` 会把每个连接到的服务器列出的**全部**工具无条件注册，而它的配置里**没有**任何白名单字段（stdio / streamable-http 两种 schema 都没有），`ctx.tools.restrict()` 也不能替代——它要求 scoped 上下文（全局调用会抛错），而且只**遮罩**定义、定义仍留在注册表里可被内省。唯一能把工具挡在注册表外的接缝是 `register` 本身，所以面板在 `apply()` 里**劫持工具服务实例上的 `register`**：

- 打在**实例**上而不是原型：按名字查找的调用方（`syncTools` 正是如此）只看得见实例上的写入；原型属于恰好被导入的那份包副本。
- **顺序上正好占优**：本插件是 bundle 层，而 MCP 行在 profile 的 `cordis.patch.yml`（用户补丁层），profile 组装时**先应用 bundle 补丁、再应用用户补丁**——所以劫持一定在 MCP 客户端注册第一批工具之前装好，且这个顺序不依赖用户手工排行。真机上 `filterState.installed === true` 且 `preExisting` 为空，证实了这一点。
- **fail-open**：判不了名字就放行。过滤器自身的 bug 不该表现成「工具凭空消失」。`Reflect.set` 在不可写属性上会返回 `false` 且可能静默失败，所以写入结果是被**验证**的——否则会出现「报告安装成功、实际一个都没过滤」这种最坏情况。
- 规则**每次注册时实时读取**，所以改完保存即对新注册生效；未配置的服务器与非 MCP 的内置工具一律放行；归属按**最长前缀**判定（`github` 与 `github__enterprise` 并存时不会挂错）。

## 已知边界

- 面板列出**磁盘上**的技能（其它工具放进去的也在），但只对其中「本插件能定位到的根」执行写操作
- **项目级 MCP 对 subagent 不可见**：subagent 只继承 root 作用域；需要所有 agent 都用就配成全局
- **工具过滤对「已注册」的工具无能为力**：插件只能在注册那一刻放行或拦下，无法注销别的插件
  已经注册的工具。所以刚开启的档位要等该服务器重新注册工具才完全见效——把该卡片「停用」再
  「启用」即可立即触发，或重启 DSH
- **工具过滤依赖工具服务的 `register` 可被写入**：若某个版本的 DSH 把它设成不可写，
  面板会显示「过滤未生效」并给出原因，而不是静默失效
- **过滤看的是公开工具名**：MCP 客户端把工具注册为 `mcp__<serverName>__<原始名>`，名字过长时
  会规范化并加哈希后缀——勾选界面里的短名就是按这个公开名切的，与服务器端的原始名可能不同
- **stdio MCP 首次启动要等**：`npx` 首次下载包约 1–2 分钟，这期间挂载已建立但工具还没注册
- **MCP 连不上之后不会永远重试**：`dsh-mcp-client` 的重试预算用完就永久放弃，只能重连或重启。
  默认预算是 **151.5 秒**（`initialDelayMs: 500`、`maxDelayMs: 30000`、`maxAttempts: 10` 的退避
  之和）。想让它长时间自己等，就把「重连最大次数」设大（如 `10000`）、「重连最大延迟」设
  `60000`；**不要勾**「连不上时拒绝激活」——勾上等于**一次都不重试**（首次尝试失败即让插件实例
  失败并清掉重试定时器）。面板上的状态标签与「重连」按钮就是为这件事准备的
- **连接状态里的时间是推导值**：`dsh-mcp-client` 不对外暴露重试计数（`failedAttempts` 在闭包
  里），所以「重试中 / 已放弃」是按该行配置算出的预算与已耗时推出来的，界面写「预计」
- **需要 OAuth 的 MCP 服务器会显示「需要授权」，而不是「坏了」**：这类服务器在未授权时拒绝
  连接是协议规定的正常行为。但 `dsh-mcp-client` **完全没有 OAuth 支持**（它不向 MCP SDK 传
  `authProvider`），于是 401 被当成普通网络故障一路重试到放弃，界面上只会说「已放弃重试」——
  把「你去补一次授权就好」说成了「这台服务器坏了」。面板会用一次轻量 HTTP 探测读 401/403 的
  `WWW-Authenticate` 挑战，把它单独标成「需要授权」（不是红色，因为不是故障）。**去授权的办法
  只能靠凭据**：给这一行加一个 `Authorization` 请求头，或换成服务器提供的带 token 的地址
  （DSH 不会弹出 OAuth 登录窗——那是客户端缺的能力，不是面板能补的）
- `command: npx` 走**用户自己的 npm 缓存**；`~/.npm` 里若有 root 所有的文件会 `EACCES`，一次性修复：`sudo chown -R $(whoami):staff ~/.npm`
- 装/更新之后：Client 半刷新页面即可，Host 半的改动需要重启 DSH（安装器与市场都会提示）

## 更多文档

| 文档 | 给谁看 |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | 每个版本改了什么 |
| [`docs/MIGRATION-0.5.5.md`](docs/MIGRATION-0.5.5.md) | 从 0.5.4 升级的人：这一版的破坏性变更、自动迁移覆盖了什么、怎么回退 |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 改这个插件的人：自测命令、诊断文件、故障恢复 |
| [`docs/PUBLISHING.md`](docs/PUBLISHING.md) | 维护者：npm 发包、GitHub Release、上架插件市场 |
| [`docs/ICON.md`](docs/ICON.md) | 改图标的人：插件的绘制规范（画布 / 尺寸 / 配色）与两个易踩的坑 |
| [`docs/ENGINEERING.md`](docs/ENGINEERING.md) | 开发手记（真机验证记录 / 事故复盘 / 踩坑清单，历史归档） |
| [`docs/oauth-feasibility.md`](docs/oauth-feasibility.md) | 想给 MCP 做「点击授权」的人：为什么 DSH 现在做不到、要写什么、每条结论的源码出处（调研，未决策） |
| [`docs/tools-persistence.md`](docs/tools-persistence.md) | 工具清单为什么不该落盘：实测体积占比、每 5 秒重写的根因、三条可选路线 |

## License

[MIT](LICENSE)
