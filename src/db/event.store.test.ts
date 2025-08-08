import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Sqlite } from './sqlite';
import { EventStore } from './event.store';
import type { MessagePayload, TracePayload } from '$src/types/event.types';

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

  it('system events use turn 0 without requiring an open turn', () => {
    // System event can be appended without any existing turn
    const sys1 = events.appendEvent({
      conversation: 1,
      type: 'system',
      payload: { kind: 'meta_created', data: { title: 'New conversation' } },
      finality: 'none',
      agentId: 'system-orchestrator',
    });
    expect(sys1.turn).toBe(0);
    expect(sys1.event).toBe(1);

    // Another system event also goes to turn 0
    const sys2 = events.appendEvent({
      conversation: 1,
      type: 'system',
      payload: { kind: 'note', data: { message: 'System note' } },
      finality: 'none',
      agentId: 'system-orchestrator',
    });
    expect(sys2.turn).toBe(0);
    expect(sys2.event).toBe(2);

    // Meanwhile, a message starts turn 1
    const msg = events.appendEvent({
      conversation: 1,
      type: 'message',
      payload: { text: 'Hello' } as MessagePayload,
      finality: 'none',
      agentId: 'user',
    });
    expect(msg.turn).toBe(1);
    expect(msg.event).toBe(1);

    // More system events still go to turn 0
    const sys3 = events.appendEvent({
      conversation: 1,
      type: 'system',
      payload: { kind: 'turn_claimed', data: { agentId: 'assistant' } },
      finality: 'none',
      agentId: 'system-orchestrator',
    });
    expect(sys3.turn).toBe(0);
    expect(sys3.event).toBe(3);

    // Verify retrieval
    const all = events.getEvents(1);
    const systemEvents = all.filter(e => e.type === 'system');
    expect(systemEvents.length).toBe(3);
    expect(systemEvents.every(e => e.turn === 0)).toBe(true);
  });

  it('trace can start a new turn when no turn exists', () => {
    // First trace starts turn 1
    const trace1 = events.appendEvent({
      conversation: 1,
      type: 'trace',
      payload: { type: 'thought', content: 'starting work' } as TracePayload,
      finality: 'none',
      agentId: 'assistant',
    });
    expect(trace1.turn).toBe(1);
    expect(trace1.event).toBe(1);

    // Subsequent traces need to specify turn or they start a new turn
    const trace2 = events.appendEvent({
      conversation: 1,
      turn: 1,  // Explicitly provide the turn to stay in same turn
      type: 'trace',
      payload: { type: 'tool_call', name: 'search', args: {}, toolCallId: 'call_1' } as TracePayload,
      finality: 'none',
      agentId: 'assistant',
    });
    expect(trace2.turn).toBe(1);
    expect(trace2.event).toBe(2);

    // Message finalizes the turn
    const msg = events.appendEvent({
      conversation: 1,
      turn: 1,  // Stay in same turn
      type: 'message',
      payload: { text: 'Here is the result' } as MessagePayload,
      finality: 'turn',
      agentId: 'assistant',
    });
    expect(msg.turn).toBe(1);
    expect(msg.event).toBe(3);

    // Next trace without turn starts turn 2 (since turn 1 is finalized)
    const trace3 = events.appendEvent({
      conversation: 1,
      type: 'trace',
      payload: { type: 'thought', content: 'processing next request' } as TracePayload,
      finality: 'none',
      agentId: 'user',
    });
    expect(trace3.turn).toBe(2);
    expect(trace3.event).toBe(1);

    // Verify all events
    const all = events.getEvents(1);
    expect(all).toHaveLength(4);
    expect(all[0]?.type).toBe('trace');
    expect(all[0]?.turn).toBe(1);
    expect(all[3]?.type).toBe('trace');
    expect(all[3]?.turn).toBe(2);
  });

  it('getEventsSince returns events with seq greater than given', () => {
    const e1 = events.appendEvent({
      conversation: 1,
      type: 'message',
      payload: { text: 'one' } as MessagePayload,
      finality: 'none',
      agentId: 'a1',
    });
    events.appendEvent({
      conversation: 1,
      type: 'message',
      payload: { text: 'two' } as MessagePayload,
      finality: 'turn',
      agentId: 'a2',
    });
    const since = events.getEventsSince(1, e1.seq);
    expect(since.length).toBe(1);
    expect((since[0]!.payload as any).text).toBe('two');
  });
});