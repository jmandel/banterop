import { Hono } from 'hono'
import type { AppBindings } from '../index'

export function fetchJsonRoutes() {
  const r = new Hono<AppBindings>()
  r.get('/fetch-json', async (c) => {
    const src = c.req.query('url') || ''
    let u: URL
    try { u = new URL(src) } catch { return c.json({ ok:false, error:'Invalid URL' }, 400) }
    if (u.protocol !== 'https:') return c.json({ ok:false, error:'Only https URLs allowed' }, 400)
    const ctrl = new AbortController()
    const tm = setTimeout(() => ctrl.abort(), 8000)
    try {
      const res = await fetch(u, { signal: ctrl.signal })
      if (!res.ok) return c.json({ ok:false, error:`Upstream error ${res.status}` }, 502)
      const ct = String(res.headers.get('content-type') || '').toLowerCase()
      const len = Number(res.headers.get('content-length') || '0')
      const max = 512 * 1024
      if (Number.isFinite(len) && len > max) return c.json({ ok:false, error:'Payload too large' }, 413)
      const text = await res.text()
      if (text.length > max) return c.json({ ok:false, error:'Payload too large' }, 413)
      try {
        const data = JSON.parse(text)
        return c.json({ ok:true, data }, 200)
      } catch {
        if (ct.includes('application/json') || ct.includes('application/ld+json')) return c.json({ ok:false, error:'Invalid JSON' }, 422)
        return c.json({ ok:false, error:'Unsupported content-type' }, 415)
      }
    } catch (e: any) {
      const msg = e?.name === 'AbortError' ? 'Timeout' : (e?.message || 'Fetch failed')
      return c.json({ ok:false, error: String(msg) }, 504)
    } finally { clearTimeout(tm) }
  })
  return r
}

