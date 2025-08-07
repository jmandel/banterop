import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Sqlite } from './sqlite';
import { ConversationStore } from './conversation.store';

describe('ConversationStore', () => {
  let sqlite: Sqlite;
  let store: ConversationStore;

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.migrate();
    store = new ConversationStore(sqlite.raw);
  });

  afterEach(() => sqlite.close());

  it('creates, reads, lists, and completes conversations', () => {
    const id = store.create({ title: 'Test', description: 'Desc', agents: [] });
    expect(id).toBeGreaterThan(0);

    const row = store.get(id)!;
    expect(row.title).toBe('Test');
    expect(row.status).toBe('active');

    const list = store.list({ status: 'active' });
    expect(list.some((c) => c.conversation === id)).toBe(true);

    store.complete(id);
    const after = store.get(id)!;
    expect(after.status).toBe('completed');
  });
});