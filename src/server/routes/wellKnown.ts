import { Hono } from 'hono'
import type { AppBindings } from '../index'

export function wellKnownRoutes() {
  const r = new Hono<AppBindings>()

  r.get('/agent-card.json', (c) => {
    const origin = new URL(c.req.url).origin
    return c.json({
      name: 'flipproxy',
      version: '1.0',
      endpoints: { pairs: `${origin}/api/pairs` },
    })
  })

  r.get('/healthz', (c) => c.text('ok'))
  return r
}

