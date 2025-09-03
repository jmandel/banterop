import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { startServer, stopServer, Spawned, openBackend, createMessage, textPart, leaseHeaders, waitUntil } from './utils'

let S: Spawned

beforeAll(async () => { S = await startServer() })
afterAll(async () => { await stopServer(S) })

describe('Rooms history — first epoch final status', () => {
  it('shows completed for epoch #1 after a completed conversation (not canceled)', async () => {
    const pairId = `t-${crypto.randomUUID()}`
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`

    // Open backend to authorize responder sends and wait for lease id
    await openBackend(S, pairId)
    await waitUntil(async () => !!(leaseHeaders(pairId)['X-Banterop-Backend-Lease']), 3000, 20)

    // Initiator sends a turn (working)
    const mInit = crypto.randomUUID()
    let res = await fetch(a2a, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ configuration:{ historyLength:0 }, message: createMessage({ parts:[textPart('start','working')], messageId: mInit }) } })
    })
    expect(res.ok).toBeTrue()

    // Responder finishes the task (completed)
    const respTaskId = `resp:${pairId}#1`
    const mResp = crypto.randomUUID()
    res = await fetch(a2a, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...leaseHeaders(pairId) },
      body: JSON.stringify({ jsonrpc:'2.0', id:'m2', method:'message/send', params:{ configuration:{ historyLength:0 }, message: createMessage({ parts:[textPart('done','completed')], taskId: respTaskId, messageId: mResp }) } })
    })
    expect(res.ok).toBeTrue()

    // History listing should show epoch 1 as completed
    const e1 = await fetch(`${S.base}/api/rooms/${pairId}/epochs?order=asc`).then(r=>r.json())
    const first = (Array.isArray(e1?.epochs) ? e1.epochs : []).find((e:any)=>e.epoch===1)
    expect(first).toBeTruthy()
    expect(first.state).toBe('completed')

    // Start epoch #2 (new conversation) and verify epoch #1 remains completed
    const mInit2 = crypto.randomUUID()
    res = await fetch(a2a, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', id:'m3', method:'message/send', params:{ configuration:{ historyLength:0 }, message: createMessage({ parts:[textPart('next','working')], messageId: mInit2 }) } })
    })
    expect(res.ok).toBeTrue()
    const e2 = await fetch(`${S.base}/api/rooms/${pairId}/epochs?order=asc`).then(r=>r.json())
    const firstAfter = (Array.isArray(e2?.epochs) ? e2.epochs : []).find((e:any)=>e.epoch===1)
    expect(firstAfter).toBeTruthy()
    expect(firstAfter.state).toBe('completed')
  })
})

