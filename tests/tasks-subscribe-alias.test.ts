import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parseSse } from '../src/shared/sse'
import { startServer, stopServer, Spawned, openBackend, textPart, createMessage, leaseHeaders } from './utils'
import { A2AClient } from '../src/frontend/transports/a2a-client'

let S: Spawned

beforeAll(async () => { S = await startServer() })
afterAll(async () => { await stopServer(S) })

describe('tasks/subscribe alias + client fallback', () => {
  it('server: tasks/subscribe acts like tasks/resubscribe', async () => {
    const pairId = `t-${crypto.randomUUID()}`
    await openBackend(S, pairId)
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`
    const initId = `init:${pairId}#1`
    const respId = `resp:${pairId}#1`

    // Kick off epoch: initiator working
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m0', method:'message/send', params:{ message: createMessage({ parts:[textPart('start','working')], taskId: initId, messageId: crypto.randomUUID() }) } }) })
    // Responder working -> initiator becomes input-required
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', ...leaseHeaders(pairId) }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ message: createMessage({ parts:[textPart('ack','working')], taskId: respId, messageId: crypto.randomUUID() }) } }) })

    // Subscribe using alias method; expect final frame then close
    const sub = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'sub', method:'tasks/subscribe', params:{ id: initId } }) })
    expect(sub.ok).toBeTrue()
    const frames: any[] = []
    for await (const f of parseSse<any>(sub.body!)) frames.push(f)
    expect(frames.length).toBe(1)
    expect(frames[0]?.kind).toBe('status-update')
    expect(frames[0]?.status?.state).toBe('input-required')
    expect(frames[0]?.final).toBeTrue()
  })

  it('client: falls back from tasks/resubscribe to tasks/subscribe when server returns JSON error with 200', async () => {
    const pairId = `t-${crypto.randomUUID()}`
    await openBackend(S, pairId)
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`
    const initId = `init:${pairId}#1`
    const respId = `resp:${pairId}#1`

    // Drive to input-required so subscribe finishes quickly
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m0', method:'message/send', params:{ message: createMessage({ parts:[textPart('start','working')], taskId: initId, messageId: crypto.randomUUID() }) } }) })
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', ...leaseHeaders(pairId) }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ message: createMessage({ parts:[textPart('ack','working')], taskId: respId, messageId: crypto.randomUUID() }) } }) })

    const client = new A2AClient(a2a)

    const realFetch = globalThis.fetch
    try {
      // Monkeypatch: respond with 200 JSON error for tasks/resubscribe; pass through others
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
          const url = typeof input === 'string' ? input : (input as any).url || String(input)
          if (url === a2a && init && typeof init.body === 'string') {
            try {
              const body = JSON.parse(init.body as string)
              if (body && body.method === 'tasks/resubscribe') {
                const payload = { jsonrpc:'2.0', id: body.id, error: { code: -32601, message: "Invalid JSON-RPC request: 'method' field is not a valid A2A method." } }
                return new Response(JSON.stringify(payload), { status:200, headers: { 'content-type':'application/json' } })
              }
            } catch {}
          }
        } catch {}
        return realFetch(input as any, init as any)
      }) as any

      const frames: any[] = []
      for await (const f of client.tasksResubscribe(initId)) frames.push(f)
      // Should receive at least the initial status-update via fallback subscribe
      expect(frames.length).toBeGreaterThan(0)
      expect(frames[0]?.kind).toBe('status-update')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

