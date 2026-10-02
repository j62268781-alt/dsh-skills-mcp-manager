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
  external: ['react', '@deepseek-ai/*'],
  loader: { '.css': 'text' },
  logLevel: 'info',
})
