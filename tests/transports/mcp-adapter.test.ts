import { describe, it, expect } from "bun:test";
import { MCPAdapter } from "../../src/frontend/transports/mcp-adapter";

function makeRpcResult(obj: any) {
  return new Response(JSON.stringify({ jsonrpc:'2.0', id:'1', result: { content:[{ type:'text', text: JSON.stringify(obj) }] } }), { status:200, headers:{ 'content-type':'application/json' } });
}

describe("MCPAdapter", () => {
  it("creates conversation on first send, mirrors messages, ticks yields on replies, snapshot and cancel work", async () => {
    const savedFetch = globalThis.fetch;
    const calls: string[] = [];
    try {
      globalThis.fetch = (async (_url: any, init?: any) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        const name = body?.params?.name;
        calls.push(name);
        if (name === 'begin_chat_thread') return makeRpcResult({ conversationId: 'conv-123' });
        if (name === 'send_message_to_chat_thread') return makeRpcResult({ ok:true });
        if (name === 'check_replies') return makeRpcResult({ messages:[{ text:'hello from agent' }], status:'working', conversation_ended:false });
        return makeRpcResult({});
      }) as any;

      const mcp = new MCPAdapter('http://fake/mcp');
      const out = await mcp.send([{ kind:'text', text:'hi' }], { messageId:'u1' });
      expect(out.taskId).toBe('conv-123');
      expect(out.snapshot.status.state).toBeDefined();

      // tick once and observe a reply
      const ac = new AbortController();
      let yielded = 0;
      const it = mcp.ticks(out.taskId, ac.signal);
      const n1 = await it.next();
      yielded += n1.done ? 0 : 1;
      ac.abort();
      expect(yielded).toBe(1);

      const snap = await mcp.snapshot(out.taskId);
      expect(snap?.status).toBeDefined();

      await mcp.cancel(out.taskId);
      const snap2 = await mcp.snapshot(out.taskId);
      expect(snap2).toBeNull();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

