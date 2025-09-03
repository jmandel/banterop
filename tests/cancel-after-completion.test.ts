import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { startServer, stopServer, Spawned, openBackend, createMessage, textPart, leaseHeaders, waitUntil } from './utils'

let S: Spawned

beforeAll(async () => { S = await startServer() })
afterAll(async () => { await stopServer(S) })

describe('Cancel after completion', () => {
  it('keeps epoch #1 completed after cancel (terminal states are permanent)', async () => {
    const pairId = `t-${crypto.randomUUID()}`
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`

    // Open backend so responder can send
    await openBackend(S, pairId)
    await waitUntil(async () => !!(leaseHeaders(pairId)['X-Banterop-Backend-Lease']), 3000, 20)

    // Initiator sends working
    const m1 = crypto.randomUUID()
    let res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m1', method:'message/send', params:{ message: createMessage({ parts:[textPart('start','working')], messageId: m1 }), configuration:{ historyLength:0 } } }) })
    expect(res.ok).toBeTrue()

    // Responder completes
    const respId = `resp:${pairId}#1`
    const m2 = crypto.randomUUID()
    res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', ...leaseHeaders(pairId) }, body: JSON.stringify({ jsonrpc:'2.0', id:'m2', method:'message/send', params:{ message: createMessage({ parts:[textPart('done','completed')], taskId: respId, messageId: m2 }), configuration:{ historyLength:0 } } }) })
    expect(res.ok).toBeTrue()

    // Verify epoch #1 is completed
    let j = await fetch(`${S.base}/api/rooms/${pairId}/epochs?order=asc`).then(r=>r.json())
    let e1 = (Array.isArray(j?.epochs)?j.epochs:[]).find((e:any)=>e.epoch===1)
    expect(e1?.state).toBe('completed')

    // Initiator calls tasks/cancel on epoch #1
    const initId = `init:${pairId}#1`
    const cancel = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'c', method:'tasks/cancel', params:{ id: initId } }) })
    expect(cancel.ok).toBeTrue()

    // Now epoch #1 should remain completed (no-op cancel)
    j = await fetch(`${S.base}/api/rooms/${pairId}/epochs?order=asc`).then(r=>r.json())
    e1 = (Array.isArray(j?.epochs)?j.epochs:[]).find((e:any)=>e.epoch===1)
    expect(e1?.state).toBe('completed')
  })
})
