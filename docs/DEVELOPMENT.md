# 开发、自测与诊断（维护者）

面向**要改这个插件、或要排查本机问题**的人。只想装上用的话，看 [README](../README.md) 就够了。

```bash
git clone https://github.com/j62268781-alt/dsh-skills-mcp-manager.git
cd dsh-skills-mcp-manager
npm install
npm run build     # dist/（Host，tsc）+ lib/client.js（Client，esbuild 单文件）
```

## 自测命令

```bash
npm test            # 140 项接口测试（node --test test/）
npm run build       # Host(tsc) + Client(esbuild)
npm run check:names # 未定义名字检查（tsc --checkJs，含客户端 TDZ 类错误）
npm run smoke       # 按 DSH 的形状真实加载插件，灌入三个通道的请求
npm run gate        # check:names → build:client → test → smoke → 离线预览基线
npm run deploy      # 部署（部署前自动跑 smoke；失败即中止，profile 不动）
npm run verify      # 校验运行中的 app 正在服务当前的 client bundle
node scripts/screenshots.mjs   # 重新生成 README 的两张截图
```

- **`npm run smoke`** 是部署闸门：按 DSH 的方式加载 `dist/index.js`，依次灌入 `skillRequest` / `importRequest` / 一条无法应用的 `rowOps`，断言「无异常逃逸、有回执、请求被清空、文件真的落盘、删除后列表同轮更新」
- **`npm run gate`** 的最后一步用离线预览页 + headless Chrome 比对 UI 基线；缺 `/tmp/preview` 夹具或 Chrome 时会**跳过**，不会假失败
- 客户端改动只有 esbuild 能兜住语法，所以改完 `lib/src/**` 一定跑一次 `npm run build:client`
- `node scripts/screenshots.mjs` 依赖 `/tmp/preview` 里的 React UMD 与参考主题 token（`SMP_PREVIEW_DIR` / `SMP_THEME_CSS` 可覆盖），缺了会跳过

## CI

| 工作流 | 什么时候跑 | 干什么 |
|---|---|---|
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | push 到 `master`、所有 PR、手动 | Node 20 / 22 / 24 三个版本各跑一遍 `npm run build` + `npm run gate`，再核对 `npm pack --dry-run` 的清单（必须含 `dist/index.js`、不能混进 `lib/src`） |
| [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) | 发布 GitHub Release（tag `v<版本>`）、手动 | 核对 tag 与版本一致 → build → gate → 发 npm（优先可信发布 OIDC，其次 `NPM_TOKEN`） |

CI 上 `smoke` 与预览基线会跳过（找不到本机 DSH 与夹具），这是预期；真正跑得起来的是
未定义名字检查、140 项单测、构建与打包清单。

## 诊断与恢复

| 文件 | 用途 |
|---|---|
| `$DSH_HOME/skills-mcp-panel.heartbeat.json` | 每次状态变化写一份：观测到的 servers/skills、挂载数、是否根 scope、上次对账的增删结果、最后一次技能操作的回执 |
| `$DSH_HOME/skills-mcp-panel.state.json` | 插件写出的技能文件清单（据此回收） |
| `$DSH_HOME/skills-mcp-panel.backups/` | 每次改写 `cordis.patch.yml` 前的自动备份 |
| 面板 URL 加 `?smp=debug` | 多出一个「Loader 诊断」分组，列出 Loader 里所有 mcp 相关行 |

两个 `.json` 随时可删，会自动重建。

**如果 profile 被隔离**（症状：模型列表消失、插件被禁用）：数据没丢，原始文件在
`$DSH_HOME/profiles/<profile>/cordis.patch.yml.bak-<毫秒>`。完整的恢复步骤（含「清掉会重放的一次性请求」这一步）
写在 [ENGINEERING.md](ENGINEERING.md) 的「恢复手册」一节。

> 插件里**绝不把异常抛出去**：DSH 的 `sanitizeProfile` 会在加载期或通道处理抛出未捕获异常时，
> 把用户整份 `cordis.patch.yml` 改名隔离并禁用其它插件。所以通道处理体一律双层 `try/catch`，
> 并由 `npm run smoke` + 部署闸门把关。

## 客户端的两条硬约束

1. **不能 `import 'react'`**：DSH 把 client bundle 当经典脚本求值（官方产物 0 个顶层 `import`），
   所以 JSX 走全局工厂 `__dshReact.createElement`，由入口 `globalThis.__dshReact = require('react')` 注入。
   `esbuild.config.mjs` 与 `scripts/jsx-hooks.mjs` 两处的 jsxFactory 必须一致。
2. **测试断言别用 `React.Children.toArray` 做引用相等**：它会克隆元素并加 key 前缀；要比较引用就遍历原始 `props.children`。

## 发布

npm 发包、GitHub Release、上架 DSH 插件市场：见 [PUBLISHING.md](PUBLISHING.md)。

## 开发手记

真机验证记录 / 事故复盘 / 踩坑清单：见 [ENGINEERING.md](ENGINEERING.md)（历史记录，部分结论已过期）。
