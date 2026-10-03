<div align="center">

# dsh-skills-mcp-manager

**在 DSH 的设置面板里管理「技能」与「MCP 服务器」——全局 / 项目级分层，改完即生效**

[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2%20实测-4c6ef5)](#)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/npm%20test-140%20passed-2ea043)](#)
[![runtime deps](https://img.shields.io/badge/运行时依赖-0-8a8f99)](#工作原理)

</div>

---

DSH 插件：把 **Skills** 与 **MCP** 的管理搬进 **设置 → Skills & MCP**。页面是「两个 tab × 两个层级」——MCP 与技能各自分「全局」和「项目级」；卡片、按钮、间距都对齐宿主内置的「内置插件」页，不 import 任何 Harness Client 包。

- 🗂️ **技能**：列表 / 搜索 / 预览全文 / 新建 / 重命名 / 删除，落盘就是 `<技能根>/<名字>/SKILL.md`；删除先备份再删，可手动恢复
- 🔌 **MCP**：全局条目就是 profile `cordis.patch.yml` 里的**真实 Loader 行**（和内置的 context7 那几行完全同构），增删改停写回配置文件；项目级条目只挂到该项目里运行的 agent
- 📥 **MCP 导入**：一键扫描 Claude Code / Cursor / VS Code / Gemini / Codex 等 **26 个来源**的用户级或项目级配置，预览后导入
- ↩️ **两级分明**：同一个页面里切换「全局」和「项目」，项目选择器带工作区补全
- 🧯 **不动坏你的配置**：插件里绝不把异常抛出去（DSH 会因此隔离整个 profile 配置），写 `cordis.patch.yml` 前自动备份、写前重新校验
- 📦 **零运行时依赖**：`react` / `yaml` 都用宿主已有的那份，插件本体不带第三方运行时依赖

**目录**：[界面预览](#界面预览) · [安装](#安装) · [使用](#使用) · [工作原理](#工作原理) · [已知边界](#已知边界) · [更多文档](#更多文档) · [License](#license)

## 界面预览

> 两张图都是**用本仓库构建出的客户端 bundle 离线渲染**的（同一套 stub 加载器 + 示例数据），
> 不是真机截图——真机截图会把作者自己的服务器地址与项目路径带进 README。
> 重新生成：`node scripts/screenshots.mjs`。

<p align="center">
  <img src="https://raw.githubusercontent.com/j62268781-alt/dsh-skills-mcp-manager/HEAD/docs/images/mcp-panel.png" width="1000" alt="MCP 面板：全局配置文件行、项目级条目、导入与搜索">
  <br><sub>MCP 面板 · 全局（配置文件行 + 停用/编辑/删除）· 项目级 · 导入 MCP</sub>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/j62268781-alt/dsh-skills-mcp-manager/HEAD/docs/images/skills-panel.png" width="1000" alt="技能面板：全局技能与项目级技能，预览/编辑/删除">
  <br><sub>技能面板 · 全局技能 / 项目级技能 · 预览 / 编辑 / 删除</sub>
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
dsh plugin --profile web add dsh-skills-mcp-manager

# 或 GitHub Release 上的预构建 tarball（链接恒定指向最新版）
dsh plugin --profile web add https://github.com/j62268781-alt/dsh-skills-mcp-manager/releases/latest/download/dsh-skills-mcp-manager.tgz
```

**重启 DSH**，再刷新页面：**设置 → Skills & MCP**。

卸载：

```bash
dsh plugin --profile web remove dsh-skills-mcp-manager
```

### 从源码（开发）

```bash
git clone https://github.com/j62268781-alt/dsh-skills-mcp-manager.git
cd dsh-skills-mcp-manager
npm install
npm run build      # dist/（Host，tsc）+ lib/client.js（Client，esbuild 单文件）
npm run deploy     # 拷贝进 profile；部署前先跑加载冒烟，失败则 profile 一字不动
```

`npm run deploy` 的目标是 `$DSH_HOME/profiles/desktop/node_modules/dsh-skills-mcp-manager`，
旧版本备份成同级的 `.backup-<时间戳>`（回滚只需改名回来）。仓库**不提交构建产物**，所以克隆后必须先 build。

之后把包名挂进 profile 的 bundles 并重启：

```jsonc
// $DSH_HOME/profiles/desktop/package.json
{ "dsh": { "profile": { "bundles": [ /* … */ "dsh-skills-mcp-manager" ] } } }
```

## 使用

入口：**设置 → Skills & MCP**（与内置插件页同一套设置槽位）。

- **搜索**只匹配名称，**不**匹配地址 / 参数 / 环境变量
- **项目选择器**决定「项目级」层显示哪个项目；下拉里是工作区注册表 + 面板里出现过的项目路径，也能手填绝对路径
- 两个层级各自可折叠，各有自己的「添加服务器 / 添加技能」按钮

### MCP

| | 全局 MCP | 项目级 MCP |
|---|---|---|
| 存在哪 | profile `cordis.patch.yml` 的 Loader 行 | 插件自己的 settings 字段 `servers[]` |
| 谁去连接 | 官方 `@deepseek-ai/dsh-mcp-client` 直接加载这些行 | 插件在 `agent/created` 时按项目路径挂载 |
| 生效范围 | 所有会话（含 subagent） | 只有该项目里运行的会话 agent |
| 增删改 | 写回配置文件（加锁 + 原子写 + 写前校验 + 自动备份） | 写进 settings 文档 |

- 卡片上的「配置文件」标签表示这一行来自 `cordis.patch.yml`；这种行可以**编辑 / 停用 / 删除**，改动由 Host 排空 `rowOps` 队列后落盘
- 展开卡片能看传输方式、地址或命令、参数、环境变量（值打码）、范围与启停状态
- 停用只是把该行的 `enabled` 置 false，不删你的配置
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

**数据通道**：第三方 bundle 不能注册自己的 `ctx.remote` 命名空间，所以两半靠**官方 settings remote** 通信——面板 UI 状态、`servers[]` / `skills[]`、Host 投影出来的 `profileServers` / `discoveredSkills`，都在同一个 settings 命名空间里。这不是绕过，是第三方插件唯一能同时触达两侧的官方管道。

**技能**：面板写的、导入的、手工放进根目录的，最终都以磁盘文件为准。Host 每 2 秒读一次运行中的 `config.skills[]`，把每个条目对账成 `<根>/<名字>/SKILL.md`，并回收自己之前写过、现在不该存在的文件（清单在 `$DSH_HOME/skills-mcp-panel.state.json`）。默认技能根与 DSH 自带的文件技能提供方一致。

**项目级 MCP**：不猜项目根——用「配置里的 scope 是否为会话 cwd 的**目录前缀**」判定，命中的 agent 才挂载，`agent/disposed` 时卸载。注意 **subagent 是独立 agent，只继承 root 作用域**，所以项目级工具对 subagent 不可见（全局工具两处都可见）。

**全局 MCP**：对 `cordis.patch.yml` 的写入照抄官方 config-editor 的做法——同一把文件锁、原子写、写前重新 `parseDocument` 校验、每次改写前自动备份，块外的用户内容逐字节保留（注释、`!!js` 表达式都不会被写坏）。

**安全边界**：DSH 的 `sanitizeProfile` 会在**插件加载或通道处理抛出未捕获异常**时，把用户整份 `cordis.patch.yml` 改名隔离并禁用其它插件。所以本插件的每个通道处理都包了双层 `try/catch`：宁可回一条失败原因，也不让异常逃出去。

## 已知边界

- 面板列出**磁盘上**的技能（其它工具放进去的也在），但只对其中「本插件能定位到的根」执行写操作
- **项目级 MCP 对 subagent 不可见**：subagent 只继承 root 作用域；需要所有 agent 都用就配成全局
- **stdio MCP 首次启动要等**：`npx` 首次下载包约 1–2 分钟，这期间挂载已建立但工具还没注册
- `command: npx` 走**用户自己的 npm 缓存**；`~/.npm` 里若有 root 所有的文件会 `EACCES`，一次性修复：`sudo chown -R $(whoami):staff ~/.npm`
- 装/更新之后：Client 半刷新页面即可，Host 半的改动需要重启 DSH（安装器与市场都会提示）

## 更多文档

| 文档 | 给谁看 |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | 每个版本改了什么 |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 改这个插件的人：自测命令、诊断文件、故障恢复 |
| [`docs/PUBLISHING.md`](docs/PUBLISHING.md) | 维护者：npm 发包、GitHub Release、上架插件市场 |
| [`docs/ENGINEERING.md`](docs/ENGINEERING.md) | 开发手记（真机验证记录 / 事故复盘 / 踩坑清单，历史归档） |

## License

[MIT](LICENSE)
