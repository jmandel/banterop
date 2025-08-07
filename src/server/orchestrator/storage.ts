// A thin facade to expose storage to the orchestrator layer
import { Sqlite } from '$src/db/sqlite';
import { EventStore } from '$src/db/event.store';
import { ConversationStore } from '$src/db/conversation.store';
import { AttachmentStore } from '$src/db/attachment.store';
import { IdempotencyStore } from '$src/db/idempotency.store';
import { TurnClaimStore } from '$src/db/turn-claim.store';
import { ScenarioStore } from '$src/db/scenario.store';
import type { Database } from 'bun:sqlite';

export class Storage {
  private db?: Sqlite;
  events!: EventStore;
  conversations!: ConversationStore;
  attachments!: AttachmentStore;
  idempotency!: IdempotencyStore;
  turnClaims!: TurnClaimStore;
  scenarios!: ScenarioStore;

  constructor(dbPath: string = ':memory:') {
    this.db = new Sqlite(dbPath);
    this.db.migrate();
    const raw = this.db.raw;
    this.events = new EventStore(raw);
    this.conversations = new ConversationStore(raw);
    this.attachments = new AttachmentStore(raw);
    this.idempotency = new IdempotencyStore(raw);
    this.turnClaims = new TurnClaimStore(raw);
    this.scenarios = new ScenarioStore(raw);
  }

  static fromDatabase(db: Database): Storage {
    const storage = Object.create(Storage.prototype) as Storage;
    storage.events = new EventStore(db);
    storage.conversations = new ConversationStore(db);
    storage.attachments = new AttachmentStore(db);
    storage.idempotency = new IdempotencyStore(db);
    storage.turnClaims = new TurnClaimStore(db);
    storage.scenarios = new ScenarioStore(db);
    // No db to close in this case
    return storage;
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}