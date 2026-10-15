/**
 * Skill writes over HTTP: `POST /<name>/skills`.
 *
 * ## Why this exists
 *
 * Adding a skill went through the settings document (`config.skillRequest`), which the Host
 * drained on a 600 ms poll. Writing the file itself takes **1 ms** (measured — `mkdir` plus one
 * `SKILL.md`), but the round-trip was: write the request → wait for the poll → write the file →
 * write the receipt back → wait for the panel's own settings poll → wait for the 2 s reconcile
 * tick → wait for the 5 s projection publish. Worst case ≈ **9.1 s** for 1 ms of work.
 *
 * Deleting felt fast only because it carries an optimistic tombstone that drops the card
 * immediately; it travelled the same slow channel. So the fix is the channel, not the delete path.
 *
 * This mirrors `mcp/rows.js`, which solved the identical problem for row commands (~30 ms now),
 * and reuses its contract exactly — see that file for the security reasoning, which applies here
 * verbatim: this route **writes files on disk**, so `requestRejection` comes first, only POST with
 * `application/json` is accepted, and the body is validated by the same schema the settings
 * channel uses so the two paths cannot drift.
 *
 * ## What does *not* move
 *
 * `read` (fetching a body for the editor/preview) stays on the settings channel. It is a read, it
 * already shows 「正在读取正文…」 while it runs, and leaving it alone keeps this change small.
 */
import { NAME } from '../identity.js'

export const SKILLS_PATH = `/${NAME}/skills`

/** Largest request body accepted, in bytes. A skill body is text; 256 KB is generous. */
const MAX_BODY = 256 * 1024

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
 * Register the skill-write route.
 *
 * `apply` is injected rather than imported so this module stays free of the disk writer and a
 * test can drive the full request/response cycle without touching a real skills root. It receives
 * an **already validated** request and returns the same receipt shape the settings channel
 * produces, so the client handles both identically.
 */
export function registerSkillRoute(ctx, { schema, apply }) {
  /** One write at a time, in arrival order. */
  let queue = Promise.resolve()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SKILLS_PATH,
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

      let request
      try {
        request = schema(JSON.parse(await readBody(req)))
      } catch (error) {
        send(400, { ok: false, reason: String(error?.message ?? error) })
        return
      }

      // Serialise: `queue` only ever holds settled promises, so a failure cannot break the
      // chain for later writes.
      const run = queue.then(async () => {
        try {
          send(200, await apply(request))
        } catch (error) {
          ctx.logger.warn('dsh-skills-mcp-manager: skill command failed: %s', String(error?.message ?? error))
          send(200, { ok: false, reason: String(error?.message ?? error) })
        }
      })
      queue = run.catch(() => {})
      await run
    },
  }))
}
