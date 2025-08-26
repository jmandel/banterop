import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { startServer, stopServer, type Spawned } from './utils'

let S: Spawned

beforeAll(async () => { S = await startServer() })
afterAll(async () => { await stopServer(S) })

describe('fetch-json proxy', () => {
  it('rejects non-https URLs', async () => {
    const r = await fetch(`${S.base}/api/fetch-json?url=${encodeURIComponent('http://example.com/x.json')}`)
    expect(r.status).toBe(400)
    const j = await r.json()
    expect(j.ok).toBeFalse()
  })

  it('rejects invalid URLs', async () => {
    const r = await fetch(`${S.base}/api/fetch-json?url=${encodeURIComponent('::::')}`)
    expect(r.status).toBe(400)
  })
})

