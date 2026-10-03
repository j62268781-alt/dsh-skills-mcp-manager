/**
 * Regenerate the README screenshots (`docs/images/*.png`).
 *
 * These are not photos of a live app: the script renders the *real* built client
 * bundle in an offline page — the same stub ModuleLoader trick the preview gate
 * uses — with sample data, then screenshots it in headless Chrome. That keeps the
 * images reproducible and free of anything private (real server URLs, paths).
 *
 * Dev-only, so it skips (exit 0) when its inputs are missing on this machine:
 *   · lib/client.js        — run `npm run build:client` first
 *   · headless Chrome      — /Applications/Google Chrome.app
 *   · React UMD + theme    — SMP_PREVIEW_DIR / SMP_THEME_CSS below
 *
 *   node scripts/screenshots.mjs
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'docs', 'images')

const BUNDLE = join(root, 'lib', 'client.js')
const CHROME = process.env.SMP_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const previewDir = process.env.SMP_PREVIEW_DIR ?? '/tmp/preview'
const themeCss = process.env.SMP_THEME_CSS
  ?? '/Users/joeson/Documents/deepseek-harness/default-workspace/pi-models-migration/dsh-ui-reference/theme/tokens.css'

const missing = [
  [existsSync(BUNDLE), `缺少 ${BUNDLE}（先跑 npm run build:client）`],
  [existsSync(CHROME), `缺少 headless Chrome：${CHROME}`],
  [existsSync(join(previewDir, 'react.js')), `缺少 ${previewDir}/react.js（React UMD）`],
  [existsSync(join(previewDir, 'react-dom.js')), `缺少 ${previewDir}/react-dom.js`],
  [existsSync(themeCss), `缺少主题 token：${themeCss}`],
].filter(([ok]) => !ok).map(([, why]) => why)

if (missing.length > 0) {
  console.log('  · 跳过截图生成：')
  for (const why of missing) console.log(`      - ${why}`)
  process.exit(0)
}

/* ------------------------------------------------------------------ 样本数据 */
// 全是编造的公开数据：真实截图会把用户自己的服务器地址与路径带进 README。
const PROJECT = '/Users/me/projects/acme-web'

const SAMPLE = {
  rowOps: [], rowOpsReady: true,
  currentWorkspace: PROJECT,
  workspaces: [{ path: PROJECT, title: 'acme-web', agentsSkillsDir: `${PROJECT}/.agents/skills` }],
  skillDirs: { userDsh: '/Users/me/.dsh/skills', userAgents: '/Users/me/.agents/skills' },
  discoveryInfo: { at: '2026-10-03T11:00:00.000Z', roots: [PROJECT], count: 2, error: '' },
  // 全局 MCP = profile 配置文件里的真实 Loader 行
  profileServers: [
    { entryId: 'include:mcp-context7', serverName: 'context7', transport: 'streamable-http', target: 'https://mcp.context7.com/mcp', enabled: true },
    { entryId: 'include:mcp-deepwiki', serverName: 'deepwiki', transport: 'streamable-http', target: 'https://mcp.deepwiki.com/mcp', enabled: true },
    { entryId: 'include:mcp-github', serverName: 'github', transport: 'stdio', target: 'npx -y @modelcontextprotocol/server-github', enabled: true },
    { entryId: 'include:mcp-filesystem', serverName: 'filesystem', transport: 'stdio', target: 'npx -y @modelcontextprotocol/server-filesystem ~/Documents', enabled: false },
  ],
  // 项目级 MCP = 面板自己挂的条目（只对该项目的会话 agent 生效）
  servers: [
    { scope: PROJECT, id: 'postgres', serverName: 'postgres', transport: 'streamable-http', url: 'http://127.0.0.1:8787/mcp', enabled: true },
  ],
  // 技能走磁盘：面板里「添加技能」写的也是 SKILL.md，列表 = 磁盘扫描结果
  skills: [],
  discoveredSkills: [
    { name: 'code-review', description: '按团队的检查清单过一遍改动，先看风险再给建议', path: '/Users/me/.agents/skills/code-review/SKILL.md', source: 'user-agents', scope: 'global' },
    { name: 'release-notes', description: '把本轮的改动整理成一份发版说明', path: '/Users/me/.agents/skills/release-notes/SKILL.md', source: 'user-agents', scope: 'global' },
    { name: 'db-migrate', description: '生成并校验数据库迁移脚本', path: `${PROJECT}/.agents/skills/db-migrate/SKILL.md`, source: 'project-agents', scope: PROJECT },
    { name: 'api-mock', description: '为前端起一个本地 mock 服务', path: `${PROJECT}/.agents/skills/api-mock/SKILL.md`, source: 'project-agents', scope: PROJECT },
  ],
  skillRequest: { op: '', scope: '', id: '', project: '', path: '', name: '', prevName: '', description: '', body: '', nonce: '' },
  skillResult: { ok: false, reason: '', name: '', body: '', at: '', nonce: '' },
  importRequest: { source: '', scope: '', project: '', nonce: '' },
  importResult: { nonce: '', files: [], servers: [], error: '' },
}

/* --------------------------------------------------------------- 离线预览页 */
const tokens = readFileSync(themeCss, 'utf8')
  .split('\n')
  .map((line) => /^(--dsw-[a-z0-9-]+):\s*(.+?);?$/.exec(line.trim()))
  .filter(Boolean)
  .map((match) => `  ${match[1]}: ${match[2]};`)
  .join('\n')

const SHELL = "body{margin:0;background:var(--dsw-alias-bg-base);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',system-ui,sans-serif;color:var(--dsw-alias-label-primary)}"
  + ".shell{display:flex;min-height:100vh}.shellNav{width:240px;flex:none;padding:24px 16px;border-right:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:14px}"
  + ".shellNav div{padding:10px 12px;border-radius:var(--dsw-radius-lg)}.shellNav div[data-active=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}"
  + ".content{flex:1;min-width:0;display:flex;flex-direction:column}"

const NAV = ['账号与余额', '通用设置', '模型', '内置插件']
  .map((label) => `<div>${label}</div>`).join('')
  + '<div data-active="true">Skills &amp; MCP</div>'
  + ['Agent 预设', '插件市场'].map((label) => `<div>${label}</div>`).join('')

const page = (client, state) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>panel preview</title>
<style>:root{\n${tokens}\n}\n${SHELL}</style></head><body>
<div class="shell"><nav class="shellNav">${NAV}</nav>
<main class="content"><div id="root"></div></main></div>
<script src="./react.js"></script><script src="./react-dom.js"></script>
<script>
window.__SAMPLE__ = ${JSON.stringify(SAMPLE)};
var captured = null;
window.__ModuleLoader__ = { load: function (spec) {
  var mod = spec.factory(function (name) {
    if (name === 'react') return window.React;
    throw new Error('preview: unknown module ' + name);
  });
  var form = { snapshot: { value: window.__SAMPLE__, status: 'ready', revision: 1 },
               set: function (f, v) { window.__SAMPLE__[f] = v; return Promise.resolve(true); } };
  mod.apply({ slots: { inject: function (s, fn) { fn(); },
                       register: function (entry, Component) { captured = { entry: entry, Component: Component }; } },
              configForms: { get: function () { return form; } } });
} };
</script>
<script>
${client}
</script>
<script>
(function () {
  var props = captured.entry.inject();
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(captured.Component, props));
  setTimeout(function () {
    if ('${state}' === 'skills') {
      var tabs = document.querySelectorAll('.smp-tab');
      for (var i = 0; i < tabs.length; i++) if (tabs[i].textContent.indexOf('Skills') === 0) tabs[i].click();
    }
  }, 60);
})();
</script></body></html>`

/* ------------------------------------------------------------------ 截图 */
const STATES = [
  { file: 'mcp-panel.png', state: 'mcp', width: 1440, height: 940 },
  { file: 'skills-panel.png', state: 'skills', width: 1440, height: 700 },
]

const workDir = join(previewDir, 'smp-screenshots')
mkdirSync(workDir, { recursive: true })
mkdirSync(outDir, { recursive: true })
copyFileSync(join(previewDir, 'react.js'), join(workDir, 'react.js'))
copyFileSync(join(previewDir, 'react-dom.js'), join(workDir, 'react-dom.js'))

const client = readFileSync(BUNDLE, 'utf8')

/** Chrome writes the PNG and then sits there, so wait for the file, not the exit. */
function shoot(pagePath, outPath, width, height) {
  return new Promise((resolveShot, reject) => {
    rmSync(outPath, { force: true })
    const child = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(workDir, 'profile')}`,
      `--window-size=${width},${height}`,
      '--force-device-scale-factor=2',
      '--virtual-time-budget=4000',
      `--screenshot=${outPath}`,
      pathToFileURL(pagePath).href,
    ], { stdio: 'ignore' })
    const started = Date.now()
    let lastSize = -1
    const timer = setInterval(() => {
      const size = existsSync(outPath) ? statSync(outPath).size : -1
      // Stable size across two polls: Chrome finished writing it.
      if (size > 0 && size === lastSize) {
        clearInterval(timer)
        child.kill('SIGKILL')
        resolveShot(size)
        return
      }
      lastSize = size
      if (Date.now() - started > 60_000) {
        clearInterval(timer)
        child.kill('SIGKILL')
        reject(new Error('截图超时：' + outPath))
      }
    }, 250)
  })
}

for (const { file, state, width, height } of STATES) {
  const pagePath = join(workDir, `p-${state}.html`)
  const outPath = join(outDir, file)
  writeFileSync(pagePath, page(client, state))
  const bytes = await shoot(pagePath, outPath, width, height)
  console.log(`  ✓ docs/images/${file}（${width}x${height} @2x，${Math.round(bytes / 1024)}KB）`)
}
console.log('  · 预览页留在', workDir, '（可打开核对，或删掉重新生成）')
