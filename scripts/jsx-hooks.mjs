/**
 * Node module hooks: compile `.jsx` on the fly with esbuild.
 *
 * Node itself only understands .js/.mjs/.cjs, so without this `node --test`
 * cannot import the client sources once they are written as JSX. Only .jsx is
 * transformed (plain .js is left to Node), which keeps the hook side-effect free
 * for every other file.
 */
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.jsx')) return nextLoad(url, context)
  const source = await readFile(new URL(url), 'utf8')
  const { code } = await transform(source, {
    loader: 'jsx',
    jsx: 'transform',
    jsxFactory: '__dshReact.createElement',
    jsxFragment: '__dshReact.Fragment',
    format: 'esm',
    target: 'node20',
    sourcefile: url,
  })
  return { format: 'module', source: code, shortCircuit: true }
}
