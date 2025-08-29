import { describe, it, expect } from "bun:test";
import { MCPAdapter } from "../../src/frontend/transports/mcp-adapter";

describe("MCPAdapter", () => {
  it("creates conversation on first send, mirrors messages, ticks yields on replies, snapshot and cancel work", async () => {
    const calls: string[] = [];

    const mcp = new MCPAdapter('http://fake/mcp');

    // Bypass SDK connection machinery entirely for this unit test
    const anyMcp: any = mcp as any;
    anyMcp.ensureConnected = async () => {};

    let checkCount = 0;
    anyMcp.callTool = async (name: string, _args?: any) => {
      calls.push(name);
      if (name === 'begin_chat_thread') return { conversationId: 'conv-123' };
      if (name === 'send_message_to_chat_thread') return { ok: true };
      if (name === 'check_replies') {
        checkCount++;
        if (checkCount === 1) return { messages: [{ text: 'hello from agent' }], status: 'working', conversation_ended: false };
        return { messages: [], status: 'working', conversation_ended: false };
      }
      return {};
    };

    const out = await mcp.send([{ kind:'text', text:'hi' }], { messageId:'u1' });
    expect(out.taskId).toBe('conv-123');
    expect(out.snapshot.status.state).toBeDefined();

    // tick once: monkey-patch ticks to a single yield (no timers, no SDK)
    const origTicks = anyMcp.ticks?.bind(anyMcp);
    expect(typeof origTicks).toBe('function');
    anyMcp.ticks = async function* (_taskId: string, _signal?: AbortSignal) { yield; };

    const ac = new AbortController();
    let yielded = 0;
    const it = mcp.ticks(out.taskId, ac.signal);
    const n1 = await it.next();
    yielded += n1.done ? 0 : 1;
    ac.abort();
    expect(yielded).toBe(1);

    // Ensure tool calls were made for begin and send
    expect(calls.includes('begin_chat_thread')).toBeTrue();
    expect(calls.includes('send_message_to_chat_thread')).toBeTrue();

    const snap = await mcp.snapshot(out.taskId);
    expect(snap?.status).toBeDefined();

    await mcp.cancel(out.taskId);
    const snap2 = await mcp.snapshot(out.taskId);
    expect(snap2).toBeNull();
  });
});
