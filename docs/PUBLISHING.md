# 发包与上架（维护者）

从零到「别人能在 DSH 插件市场里搜到并一键装上」的完整流程。
面向的是**维护者**；普通用户只需要看 [README 的安装一节](../README.md#安装)。

- 包名：`dsh-skills-mcp-manager`（npm / 仓库 / 面板 id 同名）
  > `dsh-skills-mcp-panel` 这个名字在 npm 上**已被他人占用**（KyattoCat 的同类插件），所以本包不用它。
- 仓库：<https://github.com/j62268781-alt/dsh-skills-mcp-manager>
- 市场目录：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>（DSH 里「设置 → 插件市场」的数据源）

---

## 0. 一次性准备

| 事项 | 说明 |
|---|---|
| 仓库公开 | 市场 CI 会直接拉 `raw.githubusercontent.com` 上的 `package.json`，私有仓库一律过不了 |
| 仓库 ≥ 1 天 | CI 有仓库年龄检查，新建的仓库当天提 PR 会被拒 |
| GitHub topic `dsh-plugin` | 仓库 About 里加上，收录的硬要求 |
| npm 账号 | `npm login`（发布用）；包名 `dsh-skills-mcp-manager` 目前未被占用 |
| `dsh.bundle` 清单 | 仓库根 `package.json` 里的 `dsh.bundle.patch` + 根目录 `cordis.patch.yml`——**只声明 `dsh.client` 是市场最常见的拒收原因** |

`package.json` 里与上架相关的字段（本仓库已就位）：

```jsonc
{
  "name": "dsh-skills-mcp-manager",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/j62268781-alt/dsh-skills-mcp-manager.git" }, // 必须指回被收录的仓库
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "immediately": true, "inject": ["…"] } },
  "engines": { "node": ">=20", "dsh": ">=0.2.0-0" },   // engines.dsh 只是市场卡片上的兼容提示
  "files": ["dist", "lib/client.js", "cordis.patch.yml", "icon.svg", "README.md", "CHANGELOG.md", "LICENSE"],
  "publishConfig": { "access": "public" }
}
```

> `dist/` 与 `lib/client.js` 在 `.gitignore` 里（不提交构建产物），但 `files` 白名单优先级更高，
> 它们**会被打进 npm 包**。每次都靠 `npm pack --dry-run` 确认一遍。

## 1. 发版检查

```bash
npm run gate            # check:names → build:client → npm test → smoke → 预览基线
npm run build           # dist/（Host，tsc）+ lib/client.js（Client，esbuild）
npm pack --dry-run      # 只看清单：应包含 dist/**、lib/client.js、cordis.patch.yml、icon.svg、README/LICENSE/CHANGELOG
```

`npm pack --dry-run` 是发版前最后一道自检：

- 出现 `lib/src/**` 或 `test/**` → `files` 写错了；
- 缺少 `dist/index.js` → 忘了 build（`prepack` 也会补，但别指望它兜住所有情况）。

## 2. 发到 npm

```bash
# 1) 版本号：改 package.json 的 version（同时更新 CHANGELOG.md）
npm version patch|minor|major --no-git-tag-version

# 2) 登录（首次）
npm login

# 3) 发布：prepack 会自动 npm run build，无需手动构建
npm publish

# 4) 验证
npm view dsh-skills-mcp-manager version dist.tarball
```

- `publishConfig.access=public` 已写在 `package.json` 里，不需要 `--access public`。
- 发完立刻可用的安装方式：`dsh plugin --profile <profile> add dsh-skills-mcp-manager`。
- 发错了用 `npm unpublish dsh-skills-mcp-manager@<版本>`（72 小时内、且该版本没人依赖时才行）或直接发下一个 patch 版本。

## 3. GitHub Release（推荐）

给访问不了 npm 的用户一条预构建安装路径，也让市场安装更快（市场优先用 npm，其次才是 Release tarball）：

```bash
npm pack                                  # 生成 dsh-skills-mcp-manager-<版本>.tgz
git tag v<版本> && git push --tags
```

在 Releases 里新建对应 tag 的 release，上传**两个**资产：

| 资产 | 用途 |
|---|---|
| `dsh-skills-mcp-manager-<版本>.tgz` | 锁定版本的安装链接 |
| `dsh-skills-mcp-manager.tgz` | 恒定指向最新版（别名），安装命令不用随版本改 |

```bash
dsh plugin --profile <profile> add https://github.com/j62268781-alt/dsh-skills-mcp-manager/releases/latest/download/dsh-skills-mcp-manager.tgz
```

> 用 `latest/download/` 时必须保留**无版本号**的那个资产名：只传带版本号的文件名，下一个版本发布后旧链接会 404。

## 4. 上架 DSH 插件市场

市场里的插件列表来自精选目录 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（站点与 dshmarket 都从它生成的 `plugins.json` 取数）。
**不要往 dshmarket 仓库提条目**——那里只是市场应用本身。

### 4.1 新增一个文件

fork `awesome-dsh-plugin/awesome-dsh-plugin`，新建 **一个** 文件：

```
data/plugins/j62268781-alt__dsh-skills-mcp-manager.yml
```

文件名规则是 `<owner>__<repo>.yml`。内容用本仓库的 [`docs/market-entry.yml`](market-entry.yml)（已按校验器要求写好）：

```yaml
url: https://github.com/j62268781-alt/dsh-skills-mcp-manager
name: j62268781-alt/dsh-skills-mcp-manager
category: skill
description:
  en: '…英文一行…'
  zh: '…中文一行…'
```

校验器只认这几个键（多写会被拒）：`url`（必填，必须与仓库地址完全一致）、`name`（必填）、
`category`（必填，从既定分类里选）、`description`（必填 `en`，`zh` 可选；单行，含 `: ` 时要加引号）、
`tarball`（可选，只有仓库无法从源码安装时才需要）。
**没有 `npm:` 字段**——npm 与仓库的对应关系由 CI 从 npm 的 `repository` 自动探测。

### 4.2 提 PR

- 一个 PR **最多 3 条**；只加自己这一条，别顺手改别人的；
- 不需要特定的 PR 标题格式；反馈会以 PR 评论的形式指名要改什么；
- CI 依次跑：条目数 → 从仓库 `package.json` 取 `dsh.bundle`（拿不到就拒）→ 仓库年龄 ≥ 1 天 → `awesome-lint` + 站点构建；
- 维护者还会**读源码逐条核对描述**，所以描述别写没有的功能。

### 4.3 截图

截图不写在目录条目里，而是放在**你自己仓库**根目录的 `screenshots.json`（本仓库已加）：

```json
["docs/images/mcp-panel.png", "docs/images/skills-panel.png"]
```

1–8 张，相对路径（不能以 `/` 开头、不能有 `..`），或 GitHub 图床上的 https 绝对地址。

### 4.4 生效时间

合并后站点与市场**通常一天内**自动收录；dshmarket 每次打开都会实时拉 `plugins.json`，不使用过期缓存。
之后发新版只要保证 `version` 提升 + `repository` 不变，市场会自动显示新版本号与下载量。

## 5. 本机（开发）安装

```bash
npm run deploy     # 先跑 smoke，通过后拷进 $DSH_HOME/profiles/desktop/node_modules/dsh-skills-mcp-manager
```

再把包名挂进 profile 的 bundles（`$DSH_HOME/profiles/desktop/package.json` → `dsh.profile.bundles`）：

```jsonc
"dsh-skills-mcp-manager"
```

**重启 DSH** 让 Host 半生效；之后只改客户端的话，`npm run deploy` + 刷新页面即可。
回滚：profile 的 `node_modules/dsh-skills-mcp-manager.backup-<时间戳>` 改回原名。

## 6. 每次发版的清单

- [ ] `npm run gate` 全绿
- [ ] `package.json` 的 `version` 已提升，`CHANGELOG.md` 已写
- [ ] `npm pack --dry-run` 清单正确（有 `dist/`、`lib/client.js`，没有 `lib/src/`、`test/`）
- [ ] `npm publish` 成功，`npm view dsh-skills-mcp-manager version` 是新版本
- [ ] `git tag v<版本>` + Releases 上传两个 tarball 资产
- [ ] 市场已收录时：确认卡片显示新版本（收录前先按第 4 节提 PR）
