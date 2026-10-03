# 交付说明（2026-10-03）

一个 Self-contained 的 DSH 面板插件：在设置里管理 **Skills 与 MCP**，覆盖**全局**与**项目级**两个作用域。
位于 `dsh-skills-mcp-panel/`，安装到 `~/.dsh/profiles/desktop/node_modules/@local/dsh-skills-mcp-panel`。

## 功能

**MCP**
- 全局 MCP = 真实的 `cordis.patch.yml` 行（增/删/改/停用写回该文件：加锁、写前备份、写后重新解析校验）
- 项目级 MCP = 面板自己的条目，按工作区挂载
- 来源导入：从其它工具的项目/用户级 MCP 文件扫描并导入（同名跳过、不覆盖）
- 两层的行卡片与模型页 item 结构、样式对齐；展开看字段（env/headers 打码）

**Skills**
- 发现磁盘上已有的技能：按 DSH 的四个根扫描（`project-dsh` / `project-agents` / `user-dsh` / `user-agents`），
  目录束 `<名字>/SKILL.md` 与平铺 `.md` 都支持，解析 frontmatter 的 name/description
- 标题旁标出来源：`agents`（`~/.agents` 或 `<项目>/.agents`）或 `dsh`（`<DSH_HOME>` 或 `<项目>/.dsh`）
- 点击「预览」用 DSH 官方 Modal 显示 `SKILL.md` 正文（纯文本，不含 markdown 渲染器）
- 「添加技能」弹窗：区域可选（全局 dsh/agents · 项目 agents/dsh，目录不存在会创建）
- 「编辑」弹窗：**区域只读**；改名 = **移动目录 + 重写 frontmatter `name`**（目标已存在则拒绝、移动前留备份）
- 面板不重复显示自己写入的技能（按 name + scope 去重），tab 与分组副标题的计数都含磁盘技能

**通用**：搜索只按名称匹配；项目选择器含自定义路径与「清除」；官方 Modal 做确认；加载态持续到操作真正落地。

## 门禁（提交前必须全绿）

```bash
npm run gate
# = check:names → build:client → npm test → npm run smoke → 预览基线
```

| 门禁 | 拦的事故 |
|---|---|
| `check:names` | 调用了不存在的名字（TS2304/2552）、TDZ（TS2448/2454）。覆盖 Host、20 个客户端文件、7 个脚本 |
| `build:client` | JSX / 语法错误 |
| `npm test` | 逻辑回归（135 项） |
| `npm run smoke` | 加载期或通道处理里异常逃逸 —— **这类异常会让 DSH 隔离用户整个 profile** |
| 预览基线 | 渲染回归（条目 6 · tab `MCP（5）|Skills（1）` · 停用 4 · 删除 5） |
| `npm run deploy` 内 | 部署**前**先跑 smoke，失败即中止且绝不触碰 profile |

可选：`SMP_REAL_PATCH=<真实 cordis.patch.yml> npm test` 会在真实配置的副本上验证"改一行不丢其它东西"。

## 验证到什么程度（区分事实与待办）

**已在真机（CDP 实测）确认**
- 设置里 `Skills & MCP` 页可打开；MCP 列表 6 个条目；tab 计数与列表一致（未选项目时为 `MCP（4）` / `Skills（16）`）
- 技能磁盘发现：全局 **16** 个（`~/.agents/skills`）；选中 `tcl_jiguang` 时项目级 **28** 个
- 技能 tab 计数：未选项目 16；选中 `tcl_jiguang` **44**（= 16 + 28）
- 来源 tag（`agents`/`dsh`）与左间距 6px；副标题显示**真实绝对路径**
- 「预览」弹窗显示 `context7/SKILL.md` 正文（449 字，实读磁盘内容）
- MCP 行「删除」弹出官方 Modal（标题 `删除「deepwiki」？`），点「取消」关闭且数据未变

**只在单测 / 冒烟层面确认，真机尚未点过**
- 添加与编辑技能弹窗的**保存路径**（create / update / rename）—— rename 的语义（移动目录 + 重写 frontmatter + 备份）有 9 项单测覆盖，Host 三通道有冒烟覆盖；但真机上尚未点过一次（原因见下）
- 添加弹窗里"区域"下拉的四个选项：单测断言过，真机我读错了 DOM（抓到的是页面上的项目选择器），所以**不宣称已验证**
- MCP 行的停用/启用、新增、编辑：会改动用户配置，留给用户自己点

**为什么上面这些没验**：真机当前运行的仍是修复前的构建（进程启动 10:15:05 < 修复部署 10:25:16）。
触发写操作会让它按旧代码抛异常、再次隔离 profile，所以在重启切换到修复版之前，这些写路径我**故意不点**。
重启后即可补验。

## 事故复盘与恢复手册

见 `README.md` 的「插件安全边界」一节：为什么"插件里绝不允许异常逃逸"、
2026-10-03 那次崩溃的根因与连带损失、以及被 DSH 隔离后的五步恢复流程（含备份位置）。
