/** Read-only runtime transport. Uses the same request guard as built-in Host routes. */
import { NAME } from '../identity.js'
export const RUNTIME_PATH = `/${NAME}/runtime`

export function registerRuntimeRoute(ctx, readRuntime) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RUNTIME_PATH,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      res.setHeader('cache-control', 'no-store')
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      res.setHeader('content-type', 'application/json; charset=utf-8')
      try {
        const payload = readRuntime()
        res.statusCode = 200
        res.end(JSON.stringify(payload))
      } catch (error) {
        ctx.logger.warn('dsh-skills-mcp-manager: runtime read failed: %s', String(error?.message ?? error))
        res.statusCode = 503
        res.end(JSON.stringify({ error: 'runtime-unavailable' }))
      }
    },
  }))
}
