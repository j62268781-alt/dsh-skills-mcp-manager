# Changelog

## 0.2.0

- 全局 MCP 改为 `cordis.patch.yml` 里的独立 Loader 行（面板通过 row op `add`/`update`/`delete`/`toggle` 管理）
- 项目级 MCP 仍由插件按 `agent/created` + cwd 挂进 agent 作用域
- MCP 导入：26 个来源（Claude / Cursor / VS Code / Gemini / Qwen / Continue / Crush / Zed / opencode / KIMI / Qoder / …），
  全局读用户级配置、项目级读选中工作区，跳过同名不覆盖
- 界面：行卡片对齐模型页、标题/间距/滚动条对齐内置插件页、官方 Modal 做删除确认、
  在途操作 loading（删除/切换/保存/新增）、全局限定行内展开与停用
- 诊断：心跳文件 `$DSH_HOME/skills-mcp-panel.heartbeat.json`，patch 写入前自动备份
