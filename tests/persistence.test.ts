import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseSse } from "../src/shared/sse";
import { startServer, stopServer, Spawned, decodeA2AUrl, tmpDbPath, openBackend, createMessage } from "./utils";

// Persistence tests write a temporary on-disk DB and verify recovery across restart.

// Always run persistence tests
const describeMaybe = describe as any;

let S: Spawned;
let DB: string;

describeMaybe("Persistence", () => {
  beforeAll(async () => {
    DB = tmpDbPath();
    S = await startServer({ dbPath: DB });
  });
afterAll(async () => {
  await stopServer(S);
  try {
    const fs = await import('node:fs/promises');
    await fs.rm(DB).catch(()=>{});
    await fs.rm(DB + '-wal').catch(()=>{});
    await fs.rm(DB + '-shm').catch(()=>{});
  } catch {}
});

  it("persists pair meta and tasks across restart", async () => {
    // Create an implicit room and start an epoch to create tasks
    const pairId = `t-${crypto.randomUUID()}`;
    const a2a = `${S.base}/api/rooms/${pairId}/a2a`;
    await openBackend(S, pairId);
    const initTaskId = `init:${pairId}#1`;

    // Create epoch #1 by sending a first message
    await fetch(a2a, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:'m0', method:'message/send', params:{ message: createMessage({ parts:[{ kind:'text', text:'seed' }], messageId: crypto.randomUUID() }) } }) });

    // Restart server with same DB
    await stopServer(S);
    S = await startServer({ dbPath: DB });

    // tasks/get should still return snapshot for epoch #1 initiator
    const a2a2 = `${S.base}/api/rooms/${pairId}/a2a`;
    const rget = await fetch(a2a2, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:'g', method:'tasks/get', params:{ id: initTaskId } }) });
    const jg = await rget.json();
    expect(jg.result.id).toBe(initTaskId);
    expect(jg.result.contextId).toBe(initTaskId);
  });
});
