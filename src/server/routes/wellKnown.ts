import { Hono } from 'hono'
import type { AppBindings } from '../index'

export function wellKnownRoutes() {
  const r = new Hono<AppBindings>()

  r.get('/healthz', (c) => c.text('ok'))
  
  return r
}

