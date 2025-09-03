import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { startServer, stopServer, Spawned, openBackend, createMessage, textPart } from './utils'

let S: Spawned

beforeAll(async () => { S = await startServer(); })
afterAll(async () => { await stopServer(S); })

describe('Epoch selection on first send (TDD repro)', () => {
  it('starts first conversation in epoch 1 (currently fails: observed epoch 2)', async () => {
    const pairId = `t-${crypto.randomUUID()}`
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`

    // Simulate opening the Room UI backend (acquire backend lease)
    await openBackend(S, pairId)

    // Now, simulate the Client sending the very first message without taskId
    const msgId = crypto.randomUUID()
    const r = await fetch(a2a, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'm1', method: 'message/send',
        params: { configuration: { historyLength: 0 }, message: createMessage({ parts: [textPart('hello', 'turn')], messageId: msgId }) }
      })
    })
    expect(r.ok).toBeTrue()
    const jr = await r.json()

    // We expect the first snapshot to be for epoch 1 (init:<pair>#1),
    // but currently the server bumps to epoch 2 when sending without taskId,
    // causing this expectation to fail.
    const expectedInitId = `init:${pairId}#1`
    expect(String(jr.result?.id)).toBe(expectedInitId)
  })
})

