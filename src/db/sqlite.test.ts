import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Sqlite } from './sqlite';

describe('Sqlite bootstrap and schema', () => {
  const dbPath = ':memory:';
  let sqlite: Sqlite;

  beforeEach(() => {
    sqlite = new Sqlite(dbPath);
    sqlite.migrate();
  });

  afterEach(() => {
    sqlite.close();
  });

  it('creates tables and indices', () => {
    interface TableRow {
      name: string;
    }
    interface ColumnRow {
      name: string;
    }
    
    const tables = sqlite.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as TableRow[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toEqual(
      expect.arrayContaining(['conversations', 'conversation_events', 'attachments', 'idempotency_keys'])
    );

    const hasSeqPk = sqlite.raw
      .prepare("PRAGMA table_info('conversation_events')")
      .all() as ColumnRow[];
    expect(hasSeqPk.some((c) => c.name === 'seq')).toBe(true);
  });
});