import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readSSE } from "../src/shared/a2a-utils";
import { startServer, stopServer, Spawned, decodeA2AUrl, tmpDbPath } from "./utils";

let S: Spawned;
let DB: string;

beforeAll(async () => {
  DB = tmpDbPath();
  S = await startServer({ dbPath: DB });
});
afterAll(async () => { await stopServer(S); });

describe("Persistence", () => {
  it("persists pair meta and tasks across restart", async () => {
    // Create a pair and start an epoch to create tasks
    const r = await fetch(S.base + "/api/pairs", { method:'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.initiatorJoinUrl);
    const initTaskId = `init:${pairId}#1`;

    // Create epoch #1 via a no-op stream
    {
      const res = await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify({ jsonrpc:'2.0', id:'start', method:'message/stream', params:{ message:{ role:'user', parts: [], messageId: crypto.randomUUID() } } }) });
      for await (const _ of readSSE(res)) break;
    }

    // Restart server with same DB
    await stopServer(S);
    S = await startServer({ dbPath: DB });

    // tasks/get should still return snapshot for epoch #1 initiator
    const a2a2 = `${S.base}/api/bridge/${pairId}/a2a`;
    const rget = await fetch(a2a2, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: initTaskId } }) });
    const jg = await rget.json();
    expect(jg.result.id).toBe(initTaskId);
    expect(jg.result.contextId).toBe(pairId);
  });
});

