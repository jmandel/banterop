import { Database } from 'bun:sqlite';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { SCHEMA_SQL } from './schema.sql';

export class Sqlite {
  private db: Database;

  constructor(path: string) {
    // Ensure directory exists for file-backed databases
    if (path !== ':memory:') {
      const dir = dirname(path);
      if (dir && dir !== '.' && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  migrate() {
    this.db.exec(SCHEMA_SQL);
  }

  get raw(): Database {
    return this.db;
  }

  close() {
    this.db.close();
  }
}
