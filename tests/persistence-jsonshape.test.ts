import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from 'bun:sqlite'
import { decodeA2AUrl, startServer, stopServer, tmpDbPath, Spawned, textPart } from './utils'

let S: Spawned;
let DB: string;

describe('Persistence — stored JSON shape', () => {
  beforeAll(async () => {
    DB = tmpDbPath();
    S = await startServer({ dbPath: DB });
  });
  afterAll(async () => {
    await stopServer(S);
    try {
      const fs = await import('node:fs/promises');
      await fs.rm(DB).catch(()=>{});
      await fs.rm(DB+'-wal').catch(()=>{});
      await fs.rm(DB+'-shm').catch(()=>{});
    } catch {}
  });

  it('strips role, taskId, and contextId from persisted messages', async () => {
    const r = await fetch(S.base + '/api/pairs', { method: 'POST' });
    const j = await r.json();
    const pairId = j.pairId as string;
    const a2a = decodeA2AUrl(j.links.initiator.joinA2a);

    const initTaskId = `init:${pairId}#1`;
    const messageId = `m:${crypto.randomUUID()}`;
    // Intentionally send role/taskId/contextId — server should not persist these fields
    const res = await fetch(a2a, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      jsonrpc:'2.0', id:'m', method:'message/send', params: { message: { role:'user', taskId: initTaskId, contextId: pairId, parts:[textPart('hello','working')], messageId } }
    }) });
    expect(res.ok).toBeTrue();

    // Inspect DB rows directly
    const db = new Database(DB);
    const row = db.query<{ json: string }, []>(`SELECT json FROM messages LIMIT 1`).get();
    expect(row).toBeTruthy();
    const obj = JSON.parse(row!.json);
    expect(obj.messageId).toBe(messageId);
    expect(Array.isArray(obj.parts)).toBeTrue();
    const ext = obj?.metadata?.['https://chitchat.fhir.me/a2a-ext'];
    if (ext) expect(ext.nextState).toBe('working');
    expect(obj.role).toBeUndefined();
    expect(obj.taskId).toBeUndefined();
    expect(obj.contextId).toBeUndefined();
    db.close();
  });
});

