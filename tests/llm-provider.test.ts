import { describe, it, expect } from 'bun:test'
import { makeBanteropProvider } from '../src/shared/llm-provider'

function makeResponse(body: any, ok = true, headers: Record<string,string> = { 'content-type':'application/json' }) {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500, headers })
}

describe('LLM provider extraction', () => {
  it('extracts result.text', async () => {
    const orig = globalThis.fetch
    try {
      // @ts-expect-error
      globalThis.fetch = async () => makeResponse({ result: { text: 'hello' } })
      const p = makeBanteropProvider('http://example/llm')
      const r = await p.chat({ model: 'x', messages: [{ role:'user', content:'hi'}] })
      expect(r.text).toBe('hello')
    } finally { globalThis.fetch = orig }
  })

  it('extracts choices[0].message.content', async () => {
    const orig = globalThis.fetch
    try {
      // @ts-expect-error
      globalThis.fetch = async () => makeResponse({ choices: [{ message: { content: 'hi' } }] })
      const p = makeBanteropProvider('http://example/llm')
      const r = await p.chat({ model: 'x', messages: [{ role:'user', content:'hi'}] })
      expect(r.text).toBe('hi')
    } finally { globalThis.fetch = orig }
  })

  it('strips code fences', async () => {
    const orig = globalThis.fetch
    try {
      // @ts-expect-error
      globalThis.fetch = async () => makeResponse({ result: { text: '```\nhello\n```' } })
      const p = makeBanteropProvider('http://example/llm')
      const r = await p.chat({ model: 'x', messages: [{ role:'user', content:'hi'}] })
      expect(r.text).toBe('hello')
    } finally { globalThis.fetch = orig }
  })
})

