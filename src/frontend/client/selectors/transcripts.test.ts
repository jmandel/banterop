import { describe, expect, test } from 'bun:test';
import { makeEvent, type UnifiedEvent } from '../types/events';
import { selectFrontMessages, selectAgentLog, selectLastStatus } from './transcripts';

const E = (i: number, partial: Omit<UnifiedEvent, 'seq'|'timestamp'>) => makeEvent(i, partial as any);

describe('Transcript selectors from unified event log', () => {
  test('derive left and right panes + status', () => {
    const events: UnifiedEvent[] = [
      E(1, { type: 'message', channel: 'user-planner', author: 'user', payload: { text: 'Hello' } }),
      E(2, { type: 'message', channel: 'user-planner', author: 'planner', payload: { text: 'Please confirm' } }),
      E(3, { type: 'status', channel: 'status', author: 'system', payload: { state: 'input-required' } }),
      E(4, { type: 'message', channel: 'planner-agent', author: 'planner', payload: { text: 'Ping', attachments: [{ name: 'x.txt', mimeType: 'text/plain' }] } }),
      E(5, { type: 'message', channel: 'planner-agent', author: 'agent', payload: { text: 'Pong' } }),
      E(6, { type: 'trace', channel: 'system', author: 'system', payload: { text: 'note' } }),
      E(7, { type: 'status', channel: 'status', author: 'system', payload: { state: 'working' } }),
    ] as any;

    const front = selectFrontMessages(events);
    const right = selectAgentLog(events);
    const lastStatus = selectLastStatus(events);

    expect(front.map(f => f.role)).toEqual(['you','planner','system','system','system']);
    expect(front.map(f => f.text)).toEqual([
      'Hello',
      'Please confirm',
      '— status: input-required —',
      'note',
      '— status: working —',
    ]);

    expect(right.length).toBe(2);
    expect(right[0]!.role).toBe('planner');
    expect(right[0]!.text).toBe('Ping');
    expect(right[0]!.attachments?.[0]?.name).toBe('x.txt');
    expect(right[1]!.role).toBe('agent');
    expect(right[1]!.text).toBe('Pong');

    expect(lastStatus).toBe('working');
  });
});
