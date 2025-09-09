import { beforeAll, afterAll, describe, it, expect } from 'bun:test'
import { parseSse } from '../src/shared/sse'
import { startServer, stopServer, Spawned, openBackend, textPart, createMessage, leaseHeaders } from './utils'

let S: Spawned

beforeAll(async () => { S = await startServer() })
afterAll(async () => { await stopServer(S) })

describe('message/stream projection stamps taskId/contextId for viewer', () => {
  it('projects status.message for both initial and follow-on state events', async () => {
    const pairId = `t-${crypto.randomUUID()}`
    await openBackend(S, pairId)
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`

    const initId = `init:${pairId}#1`
    const respId = `resp:${pairId}#1`

    // Start message/stream from initiator with next=working
    const stream = await fetch(a2a, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ms-proj', method: 'message/stream', params: { message: createMessage({ parts: [textPart('hello','working')], messageId: crypto.randomUUID() }) } })
    })
    expect(stream.ok).toBeTrue()
    const frames: any[] = []
    const pump = (async () => { for await (const f of parseSse<any>(stream.body!)) frames.push(f) })()

    // Let the first status frame arrive
    await new Promise(r => setTimeout(r, 50))
    expect(frames.length).toBeGreaterThan(0)
    const first = frames[0]
    expect(first?.kind).toBe('status-update')
    // Initial frame message should be projected for initiator
    const m0 = first?.status?.message
    expect(typeof m0).toBe('object')
    expect(m0?.taskId).toBe(initId)
    expect(m0?.contextId).toBe(initId)
    expect(m0?.role).toBe('user')

    // Now responder replies with next=working to flip initiator to input-required
    const rsend = await fetch(a2a, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...leaseHeaders(pairId) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'rs', method: 'message/send', params: { message: createMessage({ parts: [textPart('ack','working')], taskId: respId, messageId: crypto.randomUUID() }) } })
    })
    expect(rsend.ok).toBeTrue()
    await rsend.text()

    // Wait for the stream to finish
    await pump

    const last = frames.at(-1)
    expect(last?.kind).toBe('status-update')
    expect(last?.status?.state).toBe('input-required')
    // Follow-on state event message must be projected too
    const mN = last?.status?.message
    expect(typeof mN).toBe('object')
    expect(mN?.taskId).toBe(initId)
    expect(mN?.contextId).toBe(initId)
    expect(mN?.role).toBe('agent')
  })
})

