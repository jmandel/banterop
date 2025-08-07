import { Database } from 'bun:sqlite';
import { SCHEMA_SQL } from './schema.sql';

export class Sqlite {
  private db: Database;

  constructor(path: string) {
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