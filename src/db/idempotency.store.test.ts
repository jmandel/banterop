import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Sqlite } from './sqlite';
import { IdempotencyStore } from './idempotency.store';

describe('IdempotencyStore', () => {
  let sqlite: Sqlite;
  let store: IdempotencyStore;

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.migrate();
    store = new IdempotencyStore(sqlite.raw);
  });

  afterEach(() => sqlite.close());

  it('records and finds clientRequestId entries', () => {
    const key = { tenantId: 't1', conversation: 1, agentId: 'a1', clientRequestId: 'rid-1', seq: 123 };
    store.record(key);

    const found = store.find({
      tenantId: 't1',
      conversation: 1,
      agentId: 'a1',
      clientRequestId: 'rid-1',
    });
    expect(found).toBe(123);
  });

  it('ignores duplicate insert (idempotent)', () => {
    const key = { conversation: 2, agentId: 'a2', clientRequestId: 'rid-2', seq: 99 };
    store.record(key);
    store.record(key);
    const found = store.find({
      conversation: 2,
      agentId: 'a2',
      clientRequestId: 'rid-2',
    });
    expect(found).toBe(99);
  });
});