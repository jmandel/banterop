import { describe, expect, test } from 'bun:test';
import { makeEvent, assertEvent, type UnifiedEvent } from './events';

describe('Unified Events - assertEvent/makeEvent', () => {
  test('valid message: user→planner', () => {
    const ev = makeEvent(1, {
      type: 'message', channel: 'user-planner', author: 'user',
      payload: { text: 'hello' }
    } as any);
    expect(ev.seq).toBe(1);
    expect(typeof ev.timestamp).toBe('string');
    expect(() => assertEvent(ev as UnifiedEvent)).not.toThrow();
  });

  test('invalid: message on tool channel', () => {
    expect(() => makeEvent(1, {
      type: 'message', channel: 'tool', author: 'planner',
      payload: { text: 'oops' }
    } as any)).toThrow();
  });

  test('invalid: empty message text', () => {
    expect(() => makeEvent(2, {
      type: 'message', channel: 'user-planner', author: 'planner',
      payload: { text: '' }
    } as any)).toThrow();
  });

  test('tool_call must be on tool channel and have args object', () => {
    expect(() => makeEvent(3, {
      type: 'tool_call', channel: 'tool', author: 'planner',
      payload: { name: 'doThing', args: { a: 1 } }
    } as any)).not.toThrow();
    expect(() => makeEvent(4, {
      type: 'tool_call', channel: 'planner-agent', author: 'planner',
      payload: { name: 'doThing', args: { a: 1 } }
    } as any)).toThrow();
  });

  test('status must be on status channel by system', () => {
    expect(() => makeEvent(5, {
      type: 'status', channel: 'status', author: 'system',
      payload: { state: 'input-required' }
    } as any)).not.toThrow();
    expect(() => makeEvent(6, {
      type: 'status', channel: 'status', author: 'planner',
      payload: { state: 'input-required' }
    } as any)).toThrow();
  });

  test('read_attachment requires name and ok boolean', () => {
    expect(() => makeEvent(7, {
      type: 'read_attachment', channel: 'tool', author: 'planner',
      payload: { name: 'doc.txt', ok: true, size: 10, text_excerpt: '...' }
    } as any)).not.toThrow();
    expect(() => makeEvent(8, {
      type: 'read_attachment', channel: 'tool', author: 'planner',
      payload: { name: '', ok: false }
    } as any)).toThrow();
  });

  test('trace must be on system channel by system with non-empty text', () => {
    expect(() => makeEvent(9, {
      type: 'trace', channel: 'system', author: 'system',
      payload: { text: 'note' }
    } as any)).not.toThrow();
    expect(() => makeEvent(10, {
      type: 'trace', channel: 'status', author: 'system',
      payload: { text: 'nope' }
    } as any)).toThrow();
  });
});

