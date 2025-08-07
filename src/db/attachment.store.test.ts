import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Sqlite } from './sqlite';
import { AttachmentStore } from './attachment.store';

describe('AttachmentStore', () => {
  let sqlite: Sqlite;
  let store: AttachmentStore;

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.migrate();
    store = new AttachmentStore(sqlite.raw);

    // Seed conversation + minimal event row to satisfy FK
    sqlite.raw
      .prepare(`INSERT INTO conversations (status) VALUES ('active')`)
      .run();
    sqlite.raw
      .prepare(
        `INSERT INTO conversation_events (conversation, turn, event, type, payload, finality, agent_id)
         VALUES (1,1,1,'message','{}','none','tester')`
      )
      .run();
  });

  afterEach(() => sqlite.close());

  it('inserts and retrieves attachments', () => {
    const ids = store.insertMany({
      conversation: 1,
      turn: 1,
      event: 1,
      createdByAgentId: 'tester',
      items: [
        {
          name: 'doc.txt',
          contentType: 'text/plain',
          content: 'hello',
          summary: 'greeting',
          docId: 'doc-1',
        },
      ],
    });

    expect(ids.length).toBe(1);
    const firstId = ids[0];
    expect(firstId).toBeDefined();
    if (!firstId) throw new Error('Expected id');
    
    const a = store.getById(firstId);
    expect(a?.name).toBe('doc.txt');
    expect(a?.docId).toBe('doc-1');

    const byDoc = store.getByDocId(1, 'doc-1');
    expect(byDoc?.id).toBe(firstId);

    const list = store.listByConversation(1);
    expect(list.length).toBe(1);
  });
});