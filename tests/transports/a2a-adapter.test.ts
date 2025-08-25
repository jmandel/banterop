import { describe, it, expect } from "bun:test";
import { A2ATransport } from "../../src/frontend/transports/a2a-adapter";
import type { A2APart } from "../../src/shared/a2a-types";

function makeSnapshot(id: string, text?: string) {
  const msg = text ? { role: 'user' as const, parts: [{ kind:'text', text } as A2APart], messageId: 'm1', kind:'message', taskId: id, contextId: 'pair' } : undefined;
  return { id, contextId:'pair', kind:'task' as const, status: msg ? { state:'submitted', message: msg } : { state:'submitted' }, history: [] };
}

describe("A2ATransport", () => {
  it("send returns snapshot and taskId; snapshot proxies; cancel delegates; ticks yields", async () => {
    const events: number[] = [];
    const fakeClient = {
      async messageSend(parts: A2APart[], opts:{ taskId?:string }) { return makeSnapshot(opts.taskId || 't1', (parts[0] as any)?.text || ''); },
      async tasksGet(id: string) { return makeSnapshot(id, 'snap'); },
      async cancel(_id: string) { events.push(1); },
      async *ticks(_id: string, _signal?: AbortSignal) { yield; yield; }
    } as any;
    const t = new A2ATransport('http://fake');
    (t as any).client = fakeClient;

    const sendOut = await t.send([{ kind:'text', text:'hi' }], { taskId:'tA' });
    expect(sendOut.taskId).toBe('tA');
    expect(sendOut.snapshot.id).toBe('tA');
    expect(sendOut.snapshot.status.message?.parts?.[0]?.kind).toBe('text');

    const snap = await t.snapshot('tB');
    expect(snap?.id).toBe('tB');

    await t.cancel('tC');
    expect(events.length).toBe(1);

    let yielded = 0;
    for await (const _ of t.ticks('tZ')) { yielded++; if (yielded >= 2) break; }
    expect(yielded).toBe(2);
  });
});
