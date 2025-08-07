import { describe, it, expect } from 'bun:test';
import { SubscriptionBus } from './subscriptions';
import type { UnifiedEvent } from '$src/types/event.types';

describe('SubscriptionBus', () => {
  it('filters by conversation, type, and agent', () => {
    const bus = new SubscriptionBus();
    const received: UnifiedEvent[] = [];

    const subId = bus.subscribe({ conversation: 1, types: ['message'], agents: ['a1'] }, (e) => {
      received.push(e);
    });

    // Publish various events
    bus.publish({
      conversation: 1,
      turn: 1,
      event: 1,
      type: 'trace',
      payload: {},
      finality: 'none',
      ts: new Date().toISOString(),
      agentId: 'a1',
      seq: 1,
    });

    bus.publish({
      conversation: 2, // wrong conversation
      turn: 1,
      event: 1,
      type: 'message',
      payload: {},
      finality: 'none',
      ts: new Date().toISOString(),
      agentId: 'a1',
      seq: 2,
    });

    bus.publish({
      conversation: 1,
      turn: 1,
      event: 2,
      type: 'message',
      payload: {},
      finality: 'none',
      ts: new Date().toISOString(),
      agentId: 'a2', // wrong agent
      seq: 3,
    });

    bus.publish({
      conversation: 1,
      turn: 1,
      event: 3,
      type: 'message',
      payload: { text: 'ok' },
      finality: 'turn',
      ts: new Date().toISOString(),
      agentId: 'a1',
      seq: 4,
    });

    expect(received.length).toBe(1);
    expect(received[0]!.event).toBe(3);

    bus.unsubscribe(subId);
  });
});