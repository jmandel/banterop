import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Sqlite } from './sqlite';
import { EventStore } from './event.store';
import type { MessagePayload } from '$src/types/event.types';

describe('EventStore append invariants and retrieval', () => {
  let sqlite: Sqlite;
  let events: EventStore;

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.migrate();
    events = new EventStore(sqlite.raw);
    // Ensure conversation shell row exists
    sqlite.raw.prepare(`INSERT INTO conversations (conversation, status) VALUES (1,'active')`).run();
  });

  afterEach(() => sqlite.close());

  it('starts a new turn with a message and auto-allocates turn/event', () => {
    const res = events.appendEvent({
      conversation: 1,
      type: 'message',
      payload: { text: 'Hello' } as MessagePayload,
      finality: 'none',
      agentId: 'user',
    });
    expect(res.turn).toBe(1);
    expect(res.event).toBe(1);

    const all = events.getEvents(1);
    expect(all.length).toBe(1);
    expect((all[0]!.payload as MessagePayload).text).toBe('Hello');
  });

  it('appends trace in same open turn and then finalize with message(turn)', () => {
    events.appendEvent({
      conversation: 1,
      type: 'message',
      payload: { text: 'Start' } as MessagePayload,
      finality: 'none',
      agentId: 'user',
    });
    const t1e2 = events.appendEvent({
      conversation: 1,
      turn: 1,
      type: 'trace',
      payload: { type: 'thought', content: 'Thinking' },
      finality: 'none',
      agentId: 'user',
    });
    expect(t1e2.event).toBe(2);

    const fin = events.appendEvent({
      conversation: 1,
      turn: 1,
      type: 'message',
      payload: { text: 'Done' } as MessagePayload,
      finality: 'turn',
      agentId: 'user',
    });
    expect(fin.event).toBe(3);

    const list = events.getEvents(1);
    expect(list.map((e) => e.finality)).toEqual(['none', 'none', 'turn']);
  });

  it('rejects traces after a turn is finalized', () => {
    events.appendEvent({
      conversation: 1,
      type: 'message',
      payload: { text: 'Start' } as MessagePayload,
      finality: 'turn',
      agentId: 'user',
    });

    expect(() =>
      events.appendEvent({
        conversation: 1,
        turn: 1,
        type: 'trace',
        payload: { type: 'thought', content: 'too late' },
        finality: 'none',
        agentId: 'user',
      })
    ).toThrow(/Turn already finalized/);
  });

  it('rejects events after conversation finality=conversation', () => {
    events.appendEvent({
      conversation: 1,
      type: 'message',
      payload: { text: 'Closing' } as MessagePayload,
      finality: 'conversation',
      agentId: 'system',
    });

    expect(() =>
      events.appendEvent({
        conversation: 1,
        type: 'message',
        payload: { text: 'Should fail' } as MessagePayload,
        finality: 'none',
        agentId: 'user',
      })
    ).toThrow(/finalized/);
  });

  it('enforces finality on types (no trace/system with turn/conversation)', () => {
    expect(() =>
      events.appendEvent({
        conversation: 1,
        type: 'trace',
        payload: { type: 'thought', content: 'x' },
        finality: 'turn',
        agentId: 'user',
      })
    ).toThrow(/Only message events may set finality/);

    expect(() =>
      events.appendEvent({
        conversation: 1,
        type: 'system',
        payload: { kind: 'note' },
        finality: 'conversation',
        agentId: 'system',
      })
    ).toThrow(/Only message events may set finality/);
  });

  it('stores attachments atomically and rewrites payload to references', () => {
    // First ensure conversation exists
    const res = events.appendEvent({
      conversation: 1,
      type: 'message',
      payload: {
        text: 'See attached',
        attachments: [{ name: 'a.txt', contentType: 'text/plain', content: 'abc', summary: 'sum' }],
      } as MessagePayload,
      finality: 'turn',
      agentId: 'user',
    });
    const list = events.getEvents(1);
    const msg = list.find((e) => e.turn === res.turn && e.event === res.event)!;
    const payload = msg.payload as MessagePayload;
    expect(payload.attachments?.[0]?.id).toMatch(/^att_/);
    expect(payload.attachments?.[0]?.name).toBe('a.txt');
    expect(payload.attachments?.[0]?.content).toBeUndefined();
  });

  it('idempotency: returns existing event on duplicate clientRequestId', () => {
    const first = events.appendEvent({
      conversation: 1,
      type: 'message',
      payload: { text: 'Hello', clientRequestId: 'rid-1' } as MessagePayload,
      finality: 'none',
      agentId: 'user',
    });
    const dup = events.appendEvent({
      conversation: 1,
      type: 'message',
      payload: { text: 'Hello', clientRequestId: 'rid-1' } as MessagePayload,
      finality: 'none',
      agentId: 'user',
    });
    expect(dup.seq).toBe(first.seq);
    expect(dup.event).toBe(first.event);
  });
});