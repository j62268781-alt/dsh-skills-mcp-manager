# Changelog

## 0.3.2 — README 重写为面向用户的插件说明（含两张面板截图）+ 三处小修

- **README**：从 556 行的开发日志改成用户向的插件说明（亮点 / 界面预览 / 安装 / 使用 /
  工作原理 / 开发与自测 / 诊断与恢复 / 已知边界）；产品名定为 **dsh-skills-mcp-manager**
  （安装进 profile 的包 id 仍是 `@local/dsh-skills-mcp-panel`，改名需要单独迁移 profile 配置）
- **文档**：原 README 全文搬进 `docs/ENGINEERING.md` 留档（真机验证记录 / 事故复盘 / 踩坑清单）
- **截图**：新增 `scripts/screenshots.mjs`，用真实构建产物离线渲染 `docs/images/mcp-panel.png`
  与 `docs/images/skills-panel.png`（示例数据全是编造的，不带作者的服务器地址与路径）
- 导入卡片文案里漏出的 Markdown 星号（`**用户级**`）改为纯文本
- 技能列表页全局卡片上重复渲染了两个 `key="view"` 的「预览」按钮（同一个 key 渲染两次，
  一个按全局读、一个按项目读）；现在按条目自己的 scope 取一次，并按落盘规则推出
  `SKILL.md` 路径，预览才真的读得到正文
- 导入来源下拉补上 `vscode`：Host 的来源表里一直有 VS Code，面板之前选不到它

## 0.2.0

- 全局 MCP 改为 `cordis.patch.yml` 里的独立 Loader 行（面板通过 row op `add`/`update`/`delete`/`toggle` 管理）
- 项目级 MCP 仍由插件按 `agent/created` + cwd 挂进 agent 作用域
- MCP 导入：26 个来源（Claude / Cursor / VS Code / Gemini / Qwen / Continue / Crush / Zed / opencode / KIMI / Qoder / …），
  全局读用户级配置、项目级读选中工作区，跳过同名不覆盖
- 界面：行卡片对齐模型页、标题/间距/滚动条对齐内置插件页、官方 Modal 做删除确认、
  在途操作 loading（删除/切换/保存/新增）、全局限定行内展开与停用
- 诊断：心跳文件 `$DSH_HOME/skills-mcp-panel.heartbeat.json`，patch 写入前自动备份

## 0.3.0 — 按 create-dsh-plugin(panel) 规范完成模块化重构

### 工程结构

```
package.json          exports: "." -> ./dist/index.js (Host)，"./client" -> ./lib/client.js
tsconfig.json         tsc 构建 Host 半（allowJs，可增量转 TS）
esbuild.config.mjs    把 lib/src/** 打成单文件 lib/client.js（CSS 以 text loader 内联）
scripts/deploy.mjs    拷贝式安装进 profile（旧版自动备份；不用符号链接，见下）
src/                  Host 半（源码）
  index.js            插件入口（apply / Config / 定时器装配）
  patch/rows.js       配置文件行手术：定位/插入/改字段/启停/删除（纯函数）
  patch/apply.js      applyRowOp + backupPatch（锁与原子写可注入 setPatchIO）
  runtime/env.js      登录 PATH、内置 runtime、裸命令解析、parseEnv/splitArgs/spawnEnv
  import/sources.js   26 个来源表 + 形态适配（zed / opencode）
  import/scan.js      单来源扫描
  project/mount.js    cwd 祖先匹配 + stdio/http 挂载配置（mcp-client 可注入）
  skills/reconcile.js 技能落盘与回收（状态文件记录 owned 文件）
  diagnostics/heartbeat.js  beat / beatFile
lib/src/              Client 半（源码）
  client.js           入口与组件组合
  styles/panel.css    全部面板样式
  crud/servers.js     行操作构造（add/update/toggle/delete + 草稿/条目转换）
  crud/skills.js      技能条目（scope 归属、按 name+scope upsert、名称校验）
  crud/import.js      导入的既有名字集合与新增/跳过拆分
  crud/inflight.js    在途 loading 状态机（含 15s 超时 / 4s 编辑宽限）
  components/dialog.js  官方 Modal 删除确认
  components/card.js    展开详情字段表（环境变量始终打码）
  components/form.js    字段定义、提示文案 HINTS、校验
  components/sections.js 分组副标题与空态文案
  components/filters.js 仅按名称搜索等过滤
test/                 按接口拆分的接口测试（node --test test/）
```

### 命令

```bash
npm run check      # 两半语法检查
npm test           # 接口测试（80 项）
npm run build      # build:host (tsc) + build:client (esbuild)
npm run deploy     # 安装进 desktop profile（旧版备份为 .backup-<时间戳>）
node scripts/integration-import.mjs   # 走真实 settings 通道的导入集成测试（需 app 依赖）
```

### 为什么安装用拷贝而不是符号链接

Node 默认把符号链接解析到真实路径，Host 半的 `@deepseek-ai/*` 依赖只能从 profile 的
`node_modules` 解析 —— 链到工作区必然失败，因此 `scripts/deploy.mjs` 采用拷贝 + 备份。

### 本轮修复的静默失败（拆分过程中暴露）

- 抽 `patch/apply` 时漏导入 `writeFile`，被 `backupPatch` 的空 catch 吞掉 → **备份失效**
- 抽 `diagnostics/heartbeat` 时用 async `mkdir/writeFile` 却导入 sync 版 → **心跳文件从未写出**
- 抽 `skills/reconcile` 时把状态写入切到了 `return` 之后（不可达）→ **技能清理永不生效**
- 客户端搜索用的是整行 JSON 匹配，与"只搜名称"的要求不符 → 已改为只匹配名称
- `matchesName(undefined, 'x')` 因 `String(undefined)` 含字母 x 而假命中 → 非字符串不再匹配
- 行已消失时 toggle 的 loading 会空转到超时 → 改为立即结算

对策：空 `catch` 改为 `SMP_DEBUG=1` 时打印真实异常；新增"通用导入核对"（扫描 src/** 的
导出，谁引用未导入就补齐），这类错误不再靠报错逐个发现。

## 0.3.1 — 技能删除对齐 MCP：去掉多余边框 + 删完卡片立刻消失

用户反馈两点：技能行删除中比 MCP 多一个边框；点了删除列表不刷新。

- **多出来的边框**：删除中状态此前塞在 `data-variant=danger` 的按钮里，按钮自身的
  错误色描边就成了「删除中…」外面那圈圆角框。现在整组动作按钮在删除期间被替换成
  与 MCP 行完全一致的「转圈 + 删除中…」纯文本状态
- **删了卡片还在**：真正的来源是创建时插入的乐观卡片（`optimistic`）——删除成功后设置
  文档不再列出该技能，于是那张本地乐观卡片又被渲染出来（幽灵卡片），用户只好再点一次
  删除，第二次自然回「不存在」。现在删除回执到达即清掉该技能的乐观卡片，并登记
  `name::scope` 墓碑，直到设置文档真的跟上为止；失败且磁盘上已不存在时同样收掉幽灵卡片
- 删除失败的原因现在可见（此前写进 `skillError`，但没有任何地方渲染它）
- 删除 15 秒无回执不再无限转圈（Host 半重载/异常时会留下没有回执的请求）
- Host 半：技能操作抛异常也会写回执（以前只打日志，前端卡片会一直转圈）
- 回归测试：新增 `test/client.deleteFlow.test.mjs`（迷你 React 运行时真跑「创建 → 删除 →
  回执」流程；在修复前的 bundle 上 10 项断言中 3 项失败）；`host-smoke` 增加删除与重复
  删除断言，并把固定等待改为轮询（原先在有计时扰动时会假失败）
- `verify-served.mjs` 解码 esbuild 的 `\uXXXX` 转义后再匹配中文（此前「添加服务器」在
  正确的 bundle 上也必然假失败）
- 删除排查用的临时计时探针（`probeLines`/`probeState`/`probeRef` 与 `.smp-probe` 样式）：
  刷新延迟已定位并修复，面板上不再显示那段「① 发送 / ② 回执 / ③ 列表」的自检卡片
- `.gitignore` 忽略 `.agents/skills/`：本仓库作为工作区时，面板落在这里的项目级技能与
  删除备份属于运行时数据（早先误提交过一个冒烟技能）
