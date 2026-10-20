#!/usr/bin/env node
/**
 * 把当前版本**持久化**装进 desktop profile。
 *
 * ## 为什么 `scripts/deploy.mjs` 不够
 *
 * `deploy.mjs` 只做一件事：把仓库目录拷进
 * `~/.dsh/profiles/desktop/node_modules/@j62268781-alt/dsh-skills-mcp-manager`。
 * 但 profile 的 `package.json` 里那份依赖指向一个 **tarball**：
 *
 * ```
 * "@j62268781-alt/dsh-skills-mcp-manager": "file:.../j62268781-alt-dsh-skills-mcp-manager-0.5.5.tgz"
 * ```
 *
 * 于是 DSH 一旦重建 profile（升级、`pnpm install`、profile 自愈），
 * 就会按那份依赖重装，**把拷贝进去的目录整个覆盖掉**。
 *
 * 这条被真机踩到过一次：部署了 0.5.6、重启后 `/oauth` 与 `/oauth/callback` 都是 404，
 * 因为跑起来的其实是 tarball 里的 0.5.5 —— 而 `package.json` 说 0.5.5，一切看起来都正常。
 * 症状是「新功能完全不存在，也没有任何报错」，最难查的一类。
 *
 * ## 它做什么
 *
 * 1. `npm pack` 出当前版本的 tarball，写进 `~/.dsh/plugin-packages/`
 *    （**新版本新文件**，不覆盖旧的：回退就是把依赖改回旧 tarball）
 * 2. 把 profile `package.json` 的依赖指向新 tarball
 * 3. 顺带跑一次 `deploy.mjs`，让**不需要重建 profile** 的情况下也立刻是新代码
 * 4. 打印必须重启的提示
 *
 * ## 它不做什么
 *
 * 不执行 `pnpm install`：那是 DSH 启动时自己的事，而且 profile 的 lockfile 由 pnpm 维护，
 * 外部改动容易把状态弄坏。所以流程是「改依赖 → 重启 DSH → DSH 自己装」。
 *
 * 用法：
 *   node scripts/pack-deploy.mjs
 *   node scripts/pack-deploy.mjs --dry-run     # 只看会做什么
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const source = resolve(import.meta.dirname, '..')
const dryRun = process.argv.includes('--dry-run')
const profile = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')
// `dsh plugin --profile` 要的是名字（目录名），不是路径。
const profileName = process.env.DSH_PROFILE_NAME ?? basename(profile)
const packagesDir = join(homedir(), '.dsh', 'plugin-packages')

const PKG = '@j62268781-alt/dsh-skills-mcp-manager'
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const version = String(manifest.version ?? '')
if (version === '') throw new Error('package.json has no version')
const tarballName = `${PKG.slice(1).replace('/', '-')}-${version}.tgz`
const tarballPath = join(packagesDir, tarballName)

if (!existsSync(profile)) throw new Error(`profile not found: ${profile}`)

console.log(`  · 目标版本 ${version}`)
console.log(`  · profile  ${profile}`)
if (dryRun) {
  console.log(`  · [dry-run] 会打包到 ${tarballPath}`)
  console.log(`  · [dry-run] 会把 profile 依赖改指向它`)
  process.exit(0)
}

/**
 * 0. Host 冒烟。**打包之前**跑。
 *
 * 这一步曾经是 `deploy.mjs` 顺带做的，而我后来把 `deploy.mjs` 从流程里去掉（它会把整个仓库
 * 拷进 profile 的 node_modules，正是「安装状态分裂」的另一半），冒烟**跟着一起消失了** ——
 * 部署脚本于是变成「打包 + 改写依赖」，能装上去一个**加载不起来**的包，而没有任何一步会
 * 发现。这正是冒烟存在的理由：编译和单测都看不见「插件在真实 DSH 里 apply 时炸掉」。
 *
 * 找不到 app 的 node_modules 时它自己会跳过（并在 CI 里明确标注「未运行」），所以这一步
 * 不会让没有 DSH 本体的机器部署不了。
 */
try {
  execFileSync(process.execPath, ['scripts/host-smoke.mjs'], { cwd: source, stdio: 'inherit' })
} catch (error) {
  console.log(`  ✗ Host 冒烟失败，已中止部署：${String(error?.message ?? error)}`)
  process.exit(1)
}

// 1. Pack. `npm pack` runs `prepare` (build), so dist/ and lib/client.js are fresh.
mkdirSync(packagesDir, { recursive: true })
console.log('  · npm pack（会跑 prepare → build）…')
const packed = execFileSync('npm', ['pack', '--pack-destination', packagesDir, '--silent'], { cwd: source, encoding: 'utf8' }).trim()
const produced = join(packagesDir, packed.split('\n').pop().trim())
if (!existsSync(produced)) throw new Error(`npm pack did not produce ${produced}`)
if (produced !== tarballPath) {
  // A version mismatch means package.json and the packed name disagree; rename so the
  // dependency line and the file always agree.
  copyFileSync(produced, tarballPath)
  console.log(`  · 已重命名为 ${tarballName}`)
}
console.log(`  ✓ tarball: ${tarballPath}`)

// 2. Verify the tarball actually contains the Host build (a pack that silently shipped only
//    lib/client.js would deploy an unusable plugin and look successful).
const listed = execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' })
for (const required of ['package/dist/index.js', 'package/lib/client.js', 'package/cordis.patch.yml']) {
  if (!listed.includes(required)) throw new Error(`tarball is missing ${required} — files whitelist or build is wrong`)
}
console.log('  ✓ tarball 内含 dist/index.js、lib/client.js、cordis.patch.yml')

// 3. Let the **official plugin command** install it.
//
// 这里原先是「手改 profile 的 package.json 指向 tarball + 把仓库目录拷进 node_modules」。
// 那条路留下了一个分裂的状态，真机上炸过一次：`package.json` 说 `file:...0.5.6.tgz`，
// 而 pnpm 自己的 lock / `.modules.yaml` 还记着**上一版是 git 依赖**
// （`git+https://…/dsh-skills-mcp-panel.git#b0fe…`）。两者不一致之后，DSH 启动时的依赖
// 校正与磁盘上那份「看起来正确」的目录打架 —— 结果是插件**根本没被加载**，设置页整块消失，
// 而且没有任何报错（因为 `deploy.mjs` 把一份能解析的代码放在那里，看起来一切正常）。
//
// 官方命令 `dsh plugin --profile <name> add <tarball>` 会跑 pnpm：写 package.json、
// 更新 lockfile、按 tarball 重新安装，三者在同一次事务里对齐。手动改其中一份，就不可能对齐。
const profileManifestPath = join(profile, 'package.json')
const before = (() => {
  try {
    return String(JSON.parse(readFileSync(profileManifestPath, 'utf8'))?.dependencies?.[PKG] ?? '')
  } catch {
    return ''
  }
})()
/**
 * **先 remove 再 add。**
 *
 * 真机踩过一次，值得写下来：`dsh plugin add` 在依赖已经存在时会直接说
 * 「Already up to date」并**跳过注册**，而 profile 的 `dsh.profile.bundles` 才是装配清单
 * —— 不在里面的包，`cordis.patch.yml` 里写了条目也不会被加载。
 *
 * 那次是 DSH 自己在重启时把插件「卸载」了（hub.log: uninstall.done），它从 bundles 里
 * 摘掉了这一项，但 patch 里的条目还在、`node_modules` 里的代码也还在（我先前手工拷进去的）。
 * 于是三样东西看起来都对，唯独装配清单里没有 —— 插件不加载，设置页整块消失，**零报错**。
 *
 * `remove` + `add` 是唯一能让管理器完整走一遍注册流程的组合；只 `add` 会被判定为无事可做。
 */
try {
  execFileSync('dsh', ['plugin', '--profile', profileName, 'remove', PKG], { cwd: source, stdio: 'inherit' })
} catch {
  // 本来就没装：正常，继续 add。
}
try {
  execFileSync('dsh', ['plugin', '--profile', profileName, 'add', tarballPath], { cwd: source, stdio: 'inherit' })
} catch (error) {
  console.log(`  ✗ 安装失败（dsh plugin add）：${String(error?.message ?? error)}`)
  console.log('    不要退回手改 package.json —— 那正是让 DSH 加载不到插件的原因。')
  process.exit(1)
}
console.log(`  ✓ profile 依赖：${before || '(none)'} → file:${tarballName}`)

// **装配清单校验。** 依赖装上了、patch 里有条目，都不代表插件会被加载 —— 真正决定的是
// `dsh.profile.bundles`。这一项没进清单时，DSH 加载不到插件且不给任何提示，所以必须在这里
// 当场失败，而不是留给用户去猜「设置页为什么空了」。
{
  const manifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  if (!bundles.includes(PKG)) {
    console.log(`  ✗ ${PKG} 不在 profile 的 dsh.profile.bundles 里 —— 插件不会被加载`)
    console.log('    修法：先 `dsh plugin --profile <name> remove <pkg>` 再 add。')
    process.exit(1)
  }
  console.log(`  ✓ 已在装配清单 dsh.profile.bundles 里（共 ${bundles.length} 项）`)
}

// 曾经这里还会跑一次 `deploy.mjs`，把**整个仓库目录**拷进 profile 的 node_modules，
// 好让「不重建 profile 也立刻生效」。现在不需要了：上面那条官方命令已经把它装好了。
// 而那次拷贝恰恰是问题的另一半 —— 一份手拷进去、能正常解析的代码会让目录**看起来**是好的，
// 同时和 pnpm 自己的记录不一致。去掉它，node_modules 里的东西只由安装器决定。

console.log('')
console.log('  ✓ 已持久化。**重启 DSH** 后生效。')
console.log('    回退：把 profile package.json 里那条依赖改回旧 tarball，再重启。')
console.log(`    现有 tarball：${readdirSync(packagesDir).filter((f) => f.startsWith('j62268781-alt-dsh-skills-mcp-manager-')).join(', ')}`)
