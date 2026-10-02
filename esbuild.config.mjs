/**
 * Client-half bundler.
 *
 * DSH's ModuleLoader evaluates exactly one file per client bundle, so the panel's
 * client source may be split across `lib/src/**` (components, crud, styles) and is
 * flattened here into `lib/client.js`. CSS imported from JS is inlined.
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['lib/src/client.js'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react/*', '@deepseek-ai/*'],
  // JSX 用 React.createElement 作为工厂（classic transform），而不是自动运行时的
  // react/jsx-runtime —— 后者不一定被 DSH 的 ModuleLoader 提供，前者一定是（已是 external）。
  jsx: 'transform',
  // 全局符号而非模块绑定：模块内的 import 绑定会被打包重命名，全局不会。
  // 入口在 factory 里写 globalThis.__dshReact = require('react')。
  jsxFactory: '__dshReact.createElement',
  jsxFragment: '__dshReact.Fragment',
  loader: { '.jsx': 'jsx', '.js': 'jsx', '.css': 'text' },
  logLevel: 'info',
})
