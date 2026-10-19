/**
 * MCP import scan over HTTP: `POST /<name>/import`.
 *
 * The panel asks "which MCP servers does this tool configure here?" and gets the preview
 * directly in the response. It is a read of other tools' config files — nothing is written —
 * but the file contents can be large, so it is a POST with a JSON body rather than a query
 * string.
 *
 * This used to be `config.importRequest` + `config.importResult`: a request written into the
 * profile patch, a 600 ms Host poll, and the answer written back into the patch. Both are
 * gone; the patch only holds the panel's durable preferences now.
 */
import { NAME } from '../identity.js'

export const IMPORT_PATH = `/${NAME}/import`

/** Largest request body accepted, in bytes. */
const MAX_BODY = 16 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

/**
 * Register the import-scan route.
 *
 * `scan` receives an already validated request and returns the preview payload; it never
 * writes anything. Failures are reported as `{ ok: false, error }` in the response, not as a
 * dropped request the panel would wait for forever.
 */
export function registerImportRoute(ctx, { schema, scan }) {
  let queue = Promise.resolve()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: IMPORT_PATH,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      res.setHeader('cache-control', 'no-store')
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const type = String(req.headers?.['content-type'] ?? '')
      if (!type.includes('application/json')) {
        res.statusCode = 415
        res.end(JSON.stringify({ ok: false, reason: 'content-type must be application/json' }))
        return
      }

      const send = (status, payload) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(payload))
      }

      let request
      try {
        request = schema(JSON.parse(await readBody(req)))
      } catch (error) {
        send(400, { ok: false, reason: String(error?.message ?? error) })
        return
      }

      const runScan = queue.then(async () => {
        try {
          send(200, scan(request))
        } catch (error) {
          ctx.logger.warn('dsh-skills-mcp-manager: import scan failed: %s', String(error?.message ?? error))
          send(200, { ok: false, files: [], servers: [], error: String(error?.message ?? error) })
        }
      })
      queue = runScan.catch(() => {})
      await runScan
    },
  }))
}
