# 0.5.6 — 配置与文件分家：技能只剩磁盘，MCP 只剩文件 CRUD

> 面向从 **0.5.5** 升级。这一版删掉了插件 settings 里的**全部技能、读模型与命令字段**：
> 技能不再是 `config.skills[]` 的镜像，MCP 的增删改与命令也不再经过 settings 队列。
> 升级会自动迁移，但 **Host 侧改动需要重启一次 DSH**。

## 一分钟版

| 你担心的事 | 实际情况 |
|---|---|
| 我的技能会丢吗 | **不会。** 迁移把 `config.skills[]` 里的条目写成 `SKILL.md`；已存在的文件优先，不会被覆盖 |
| MCP 服务器会丢吗 | **不会。** `config.servers[]` 条目转成带 `scope` 的 Loader 行；已有的同名行不覆盖 |
| yml 里还会写技能/运行态吗 | **不会。** 迁移会删掉那些键；插件的 `config` 只剩 `toolFilters` |
| 需要手动改配置吗 | 不需要。迁移自动完成，写前备份 |
| 需要重启吗 | **需要一次。** Host 侧新增了路由、删掉了 settings 队列 |
| 旧面板还能用吗 | **不能。** 0.5.x 面板依赖 settings 投影与队列；请一起升级 |

## 一、为什么这是破坏性变更

0.5.x 的两条 settings 通道承担了三种完全不同的东西：

1. **业务文件**（`SKILL.md`）的间接写入（`config.skills[]` → 2s 对账 → 落盘）；
2. **命令**（`rowOps` / `skillRequest` / `reconnectRequest` / `importRequest`）；
3. **读模型 / 投影**（`profileServers` / `discoveredSkills` / `probeState` / `oauthServers` …）。

它们都被持久化进 `cordis.patch.yml`，于是「一条命令」变成了「重启后可能重放的配置」，
「一个缓存」变成了「每 5 秒重写一次的 yml 字段」。0.5.6 把它们拆开：

| 数据 | 新的归属 |
|---|---|
| 技能 | 磁盘上的 `<根>/<名字>/SKILL.md`（唯一真源） |
| MCP 配置 | `cordis.patch.yml` 里的 Loader 行（唯一真源） |
| 列表 / 工具 / 连接 / 授权状态 | `GET /dsh-skills-mcp-manager/runtime` 现算 |
| 命令 | 各自 HTTP 路由的请求/响应 |
| 用户偏好 | 只剩 `toolFilters`（仍走官方 settings remote） |

## 二、迁移项

### 1. `config.skills[]` → `SKILL.md`

- 对每个 **enabled** 条目，按它自己的 `scope` + `id` 选根，渲染成
  `<根>/<名字>/SKILL.md`；
- **文件已存在时不覆盖**（以磁盘为准），只删除配置条目；
- 写失败时保留 `skills` 键，下次启动重试，绝不丢掉唯一一份正文。

### 2. `config.servers[]` → profile 行

- 复用面板 add 的同一套转换（stdio 的 `args`/`env`、http 的 `headers`、连接参数），
  每条带 `scope` 写成 `mcp-client` 行；项目行同时写 `disabled: true`（Loader 不连，插件挂）；
- 已有同名行（`mcp-<name>`）不覆盖；
- 迁移后删除 `servers` 键。

### 3. 读模型 / 命令字段清理

迁移会删除以下键（它们现在要么在 `/runtime`，要么是路由请求）：
`serverTools`、`serverToolsError`、`serverStatus`、`profileServers`、`filterState`、
`probeState`、`workspaces`、`currentWorkspace`、`workspaceServers`、`discoveryInfo`、
`discoveredSkills`、`skillDirs`、`oauthState`、`oauthServers`、`rowOps`、`rowOpsReady`、
`importRequest`、`importResult`、`skillRequest`、`skillResult`、`reconnectRequest`、
`reconnectResult`、`reconnectReady`。

### 4. 技能归属清单

`$DSH_HOME/dsh-skills-mcp-manager.state.json` 不再被使用（没有镜像/回收逻辑了），
原地保留，可手动删除。

## 三、路由变化

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/<name>/rows` | MCP 行 add/update/toggle/delete；响应带写后的行列表 |
| `POST` | `/<name>/skills` | 技能 create/update/rename/delete（直接写文件） |
| `GET` | `/<name>/skill?path=` | 读取一个已被扫描到的 `SKILL.md` 正文 |
| `POST` | `/<name>/reconnect` | 重连（命令；同步等待结果） |
| `POST` | `/<name>/import` | 扫描外部工具的 MCP 配置文件，返回预览 |
| `GET` | `/<name>/runtime` | 行列表 + 工具 + 连接/授权状态 + 技能扫描 + 工作区 |
| `POST` | `/<name>/oauth` | OAuth 命令（沿用） |

所有写路由仍先过 `connection.requestRejection()`，只接受 POST + `application/json`
（`GET /skill` 只接受 GET），串行执行；没有 settings 回退队列。

## 四、升级步骤

1. 升级包：`dsh plugin --profile desktop add @j62268781-alt/dsh-skills-mcp-manager@0.5.6`
2. **重启一次 DSH**
3. 打开 **设置 → Skills & MCP**，确认：
   - MCP 列表里有原有服务器（全局 + 项目级）；
   - 技能列表里有原有技能（它们现在来自磁盘）；
   - 旧的「受管技能」开关消失是预期行为（磁盘文件没有 enabled 表示）。

## 五、回退

0.5.6 的迁移是**删除式**的：`skills`/`servers` 键被删掉、换成行/文件。回退到 0.5.5 前，
请从 `$DSH_HOME/dsh-skills-mcp-manager.backups/cordis.patch.yml.bak`（迁移前的一份）
或你自己的版本控制恢复 `cordis.patch.yml`。业务文件（`SKILL.md`）仍在磁盘上，不会丢。
