/**
 * Panel commands over HTTP: `POST /<name>/rows`.
 *
 * ## Why this exists
 *
 * Commands used to travel through the settings document (`config.rowOps`), which the Host
 * drained on a 500 ms poll. Writing the profile patch itself takes ~1–5 ms (measured), but
 * the round-trip was: write the queue → wait for the poll → a fixed 1200 ms pause → write the
 * patch → wait for the Loader to reload it → republish the projection → wait for the panel's
 * own poll. That is 2–4 s of *waiting* for 5 ms of work, and the panel could only show a
 * spinner meanwhile.
 *
 * DSH's own plugins use the same `webServer` service for exactly this kind of thing
 * (`dsh-host-open-in-app` serves `GET /open-in-app/apps` through it, and
 * `dsh-deepseek-account-platform` runs its whole OAuth callback on it), and this plugin
 * already reads runtime data over a route (`GET /<name>/runtime`). So commands now go the
 * same way: one request, applied immediately, with the outcome in the response.
 *
 * ## Security
 *
 * This route **writes the user's config file**, so it is treated differently from the read
 * route:
 *
 *   · `connection.requestRejection(req)` first — the same trust check DSH's own routes use
 *     (Host header must be loopback/trusted, `sec-fetch-site: cross-site` is refused, Origin
 *     must be same-origin, plus the browser-auth cookie). The panel is same-origin and
 *     carries the cookie, so it passes; a random page in the user's browser does not.
 *   · **Only POST**, with `content-type: application/json` required. That, plus the
 *     same-origin check above, is what keeps a cross-site form post from reaching the write
 *     path: a simple HTML form cannot send `application/json`.
 *   · The body is validated by the **same `RowOp` schema** the settings channel used, so the
 *     two paths cannot drift and unknown fields never reach the patch writer.
 *   · No credentials are ever returned, and errors are reported as a short reason string —
 *     never a stack or a file path from the user's machine.
 *
 * ## Ordering
 *
 * Requests are serialised through one promise chain. Two clicks arriving together must not
 * interleave two read-modify-write cycles on `cordis.patch.yml`; `applyRowOp` takes a file
 * lock, but serialising here keeps the *responses* in the order the user acted and makes the
 * last write win in a predictable way.
 */
import { NAME } from '../identity.js'

export const ROWS_PATH = `/${NAME}/rows`

/** Largest command body accepted, in bytes. A row op is a few hundred bytes. */
const MAX_BODY = 32 * 1024

/** Read a request body, refusing anything oversized. */
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
 * Register the command route.
 *
 * `apply` is injected rather than imported so this module stays free of the patch writer and
 * a test can drive the full request/response cycle without a profile on disk. It receives an
 * **already validated** op.
 */
export function registerRowRoute(ctx, { schema, apply }) {
  /** One command at a time, in arrival order. */
  let queue = Promise.resolve()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROWS_PATH,
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
      // Required, not merely accepted: a cross-site HTML form cannot send this type, so
      // demanding it turns "same-origin script" into a precondition of the write path.
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

      let op
      try {
        // The **same schema** the settings channel validated with, so the two paths cannot
        // drift and an unknown field never reaches the patch writer. Calling it applies the
        // documented defaults and throws on anything malformed.
        op = schema(JSON.parse(await readBody(req)))
      } catch (error) {
        send(400, { ok: false, reason: String(error?.message ?? error) })
        return
      }

      // Serialise: `queue` only ever holds settled promises, so a failure cannot break the
      // chain for later commands.
      const run = queue.then(async () => {
        try {
          const result = await apply(op)
          send(200, result)
        } catch (error) {
          ctx.logger.warn('dsh-skills-mcp-manager: row command failed: %s', String(error?.message ?? error))
          send(200, { ok: false, reason: String(error?.message ?? error) })
        }
      })
      queue = run.catch(() => {})
      await run
    },
  }))
}
