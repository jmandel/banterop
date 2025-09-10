import { describe, it, expect } from 'bun:test'
import { A2AClient } from '../src/frontend/transports/a2a-client'

function sseFromObjects(objs: any[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const o of objs) {
        const line = `data: ${JSON.stringify({ result: o })}\n\n`
        controller.enqueue(enc.encode(line))
      }
      // Close immediately after sending
      controller.close()
    }
  })
}

describe('A2AClient.ticks: treat input-required (without final) as end-of-cycle', () => {
  it('stops after input-required until messageSend resumes', async () => {
    const origFetch = globalThis.fetch
    const endpoint = 'http://example.invalid/a2a'
    const taskId = 'init:room#1'
    let subscribeCalls = 0
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as any)?.url || String(input)
        if (url === endpoint && init && typeof (init as any).body === 'string') {
          try {
            const body = JSON.parse((init as any).body as string)
            if (body && (body.method === 'tasks/resubscribe' || body.method === 'tasks/subscribe')) {
              subscribeCalls++
              const ev = { kind:'status-update', taskId, contextId: taskId, status: { state:'input-required', message: { kind:'message', role:'agent', parts:[], messageId:'m1' } }, final: false }
              const stream = sseFromObjects([ev])
              return new Response(stream as any, { status:200, headers: { 'content-type':'text/event-stream' } })
            }
            if (body && body.method === 'message/send') {
              const res = { id: taskId, kind:'task', contextId: taskId, status:{ state:'working' }, history: [] }
              return new Response(JSON.stringify({ jsonrpc:'2.0', id: body.id, result: res }), { status:200, headers: { 'content-type':'application/json' } })
            }
          } catch {}
        }
        return new Response(JSON.stringify({ jsonrpc:'2.0', id: crypto.randomUUID(), error:{ code: -32601, message:'Invalid JSON-RPC request: method not supported in test' } }), { status:200, headers: { 'content-type':'application/json' } })
      }) as any

      const client = new A2AClient(endpoint)
      const ac = new AbortController()
      let yields = 0

      const reader = (async () => {
        for await (const _ of client.ticks(taskId, ac.signal)) { yields++ }
      })()

      // Give the stream a moment to be consumed
      await new Promise(r => setTimeout(r, 50))
      expect(subscribeCalls).toBe(1)

      // Wait past the default backoff (≥500ms). If client re-subscribed automatically, calls > 1
      await new Promise(r => setTimeout(r, 700))
      expect(subscribeCalls).toBe(1)

      // Now send a message (resume). This should cause ticks() to subscribe again once.
      await client.messageSend([], { taskId, messageId: crypto.randomUUID() })

      // Allow a moment for reconnect
      await new Promise(r => setTimeout(r, 50))
      expect(subscribeCalls).toBe(2)

      // Stop the loop
      ac.abort()
      await reader
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
