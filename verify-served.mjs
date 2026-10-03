/**
 * Ask the running Harness for its boot payload and the combo bundle that carries
 * this plugin, proving the app composed it and serves the current client half.
 *
 * The browser-session cookie is minted from the same grant secret the app uses
 * (`~/.dsh/.credentials.yaml` → client-connection/browser-session).
 */
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const authority = process.env.DSH_AUTHORITY ?? '127.0.0.1:19387'
const secret = Buffer.from(
  readFileSync(`${process.env.HOME}/.dsh/.credentials.yaml`, 'utf8')
    .match(/secret:\s*(\S+)/)[1].replace(/-/g, '+').replace(/_/g, '/'),
  'base64',
)
const b64url = (buffer) => Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const cookieName = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`
const now = Date.now()
const body = b64url(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3600_000 }))
const cookie = `${cookieName}=v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`

const html = await (await fetch(`http://${authority}/`, { headers: { cookie } })).text()
const urls = [...html.matchAll(/["'(](plugins\/\?\?[^"')]+)/g)].map((match) => match[1].replace(/&amp;/g, '&'))
const combo = urls.find((url) => url.includes('@j62268781-alt/dsh-skills-mcp-manager/client.js'))
if (!combo) {
  console.error('✗ boot 数据里没有本插件：app 尚未 composer 该 bundle')
  process.exit(1)
}
console.log('✓ boot 数据包含本插件（combo', combo.length, '字符）')
const text = await (await fetch(`http://${authority}/${combo}`, { headers: { cookie } })).text()
// esbuild emits ASCII-only output, so every Chinese string arrives as `\uXXXX`.
// Searching the raw body made non-ASCII needles fail even on a correct bundle.
const decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
const checks = [
  '.smp-page',
  'data-variant=outline',
  'settings.section',
  '.smp-tag',
  '添加服务器',
  // The delete-flow fix: a receipt-less delete must not spin forever, and the
  // delete status must be a plain status rather than the danger button.
  '删除没有回执',
  'smp-pending',
]
for (const needle of checks) console.log(`  ${decoded.includes(needle) ? '✓' : '✗'} ${needle}`)
process.exit(checks.every((needle) => decoded.includes(needle)) ? 0 : 1)
