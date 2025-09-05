import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { startServer, stopServer, Spawned, openBackend } from './utils'
import { A2ATransport } from '../src/frontend/transports/a2a-adapter'
import { useAppStore } from '../src/frontend/state/store'

let S: Spawned

beforeAll(async () => { S = await startServer() })
afterAll(async () => { await stopServer(S) })

describe('plannerTrace stamping', () => {
  it('manual sends include plannerType=off and empty journal', async () => {
    const pairId = `t-${crypto.randomUUID()}`
    const endpoint = `${S.base}/api/rooms/${pairId}/a2a`
    const adapter = new A2ATransport(endpoint)
    await openBackend(S, pairId)
    useAppStore.getState().init('initiator', adapter)

    // Create a manual draft and send
    const composeId = useAppStore.getState().appendComposeIntent('hello world')
    await useAppStore.getState().sendCompose(composeId, 'working')

    const taskId = useAppStore.getState().taskId!
    expect(typeof taskId).toBe('string')

    // Fetch snapshot from server and inspect message metadata
    const r = await fetch(endpoint, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: taskId } }) })
    expect(r.ok).toBeTrue()
    const jr = await r.json()
    const msg = jr?.result?.status?.message
    expect(!!msg).toBeTrue()
    const meta = (msg?.metadata || {})
    const ext = Object.values(meta)[0] as any // our A2A extension bucket
    expect(ext && typeof ext === 'object').toBeTrue()
    const trace = ext?.plannerTrace
    expect(trace && typeof trace === 'object').toBeTrue()
    expect(trace.plannerType).toBe('off')
    expect(Array.isArray(trace.journal)).toBeTrue()
    expect((trace.journal as any[]).length).toBe(0)
  })
})
