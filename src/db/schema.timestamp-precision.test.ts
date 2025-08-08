import { describe, it, expect } from "bun:test";
import { Sqlite } from "./sqlite";
import { EventStore } from "./event.store";
import type { MessagePayload } from "$src/types/event.types";

describe("DB timestamp precision", () => {
  it("records millisecond precision in ts", () => {
    const sqlite = new Sqlite(":memory:");
    sqlite.migrate();
    const store = new EventStore(sqlite.raw);

    sqlite.raw.prepare(`INSERT INTO conversations (status) VALUES ('active')`).run();

    store.appendEvent({
      conversation: 1,
      type: "message",
      payload: { text: "First" } as MessagePayload,
      finality: "none",
      agentId: "a1",
    });

    // Small delay to ensure different millisecond
    Bun.sleepSync(2);

    store.appendEvent({
      conversation: 1,
      type: "message",
      payload: { text: "Second" } as MessagePayload,
      finality: "none",
      agentId: "a1",
    });

    const events = store.getEvents(1);
    // Check that timestamps have millisecond precision
    expect(events[0]?.ts).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(events[1]?.ts).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // And they should be different
    expect(events[0]?.ts).not.toBe(events[1]?.ts);
    sqlite.close();
  });

  it("records millisecond precision in created_at and updated_at", () => {
    const sqlite = new Sqlite(":memory:");
    sqlite.migrate();

    // Insert a conversation
    const stmt = sqlite.raw.prepare(`
      INSERT INTO conversations (title, description, status) 
      VALUES ('Test', 'Test conversation', 'active')
      RETURNING created_at, updated_at
    `);
    const result = stmt.get() as { created_at: string; updated_at: string };

    // Check both timestamps have millisecond precision
    expect(result.created_at).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result.updated_at).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    sqlite.close();
  });

  it("records millisecond precision in attachments created_at", () => {
    const sqlite = new Sqlite(":memory:");
    sqlite.migrate();

    // Setup: create conversation and event
    sqlite.raw.prepare(`INSERT INTO conversations (status) VALUES ('active')`).run();
    sqlite.raw.prepare(`
      INSERT INTO conversation_events (conversation, turn, event, type, payload, finality, agent_id)
      VALUES (1, 1, 1, 'message', '{}', 'none', 'test')
    `).run();

    // Insert attachment
    const stmt = sqlite.raw.prepare(`
      INSERT INTO attachments (id, conversation, turn, event, name, content_type, content, created_by_agent_id)
      VALUES ('att_test', 1, 1, 1, 'test.txt', 'text/plain', 'content', 'test')
      RETURNING created_at
    `);
    const result = stmt.get() as { created_at: string };

    expect(result.created_at).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    sqlite.close();
  });

});