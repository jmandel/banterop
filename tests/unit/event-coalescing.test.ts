import { describe, it, expect } from 'bun:test';
import { coalesceEvents, coalesceTurns } from '$src/lib/utils/event-coalescing';
import type { UnifiedEvent } from '$src/types/event.types';

describe('Event Coalescing', () => {
  describe('coalesceEvents', () => {
    it('should hide events before abort marker in a turn', () => {
      const events: UnifiedEvent[] = [
        {
          conversation: 1,
          turn: 1,
          event: 1,
          type: 'message',
          payload: { text: 'First attempt' },
          finality: 'none',
          ts: '2024-01-01T00:00:00Z',
          agentId: 'agent-a',
          seq: 1
        },
        {
          conversation: 1,
          turn: 1,
          event: 2,
          type: 'trace',
          payload: { type: 'thought', content: 'Error occurred' },
          finality: 'none',
          ts: '2024-01-01T00:00:01Z',
          agentId: 'agent-a',
          seq: 2
        },
        {
          conversation: 1,
          turn: 1,
          event: 3,
          type: 'trace',
          payload: { type: 'turn_cleared', abortedBy: 'agent-a', timestamp: '2024-01-01T00:00:02Z' },
          finality: 'none',
          ts: '2024-01-01T00:00:02Z',
          agentId: 'agent-a',
          seq: 3
        },
        {
          conversation: 1,
          turn: 1,
          event: 4,
          type: 'message',
          payload: { text: 'Second attempt' },
          finality: 'turn',
          ts: '2024-01-01T00:00:03Z',
          agentId: 'agent-a',
          seq: 4
        }
      ];

      const coalesced = coalesceEvents(events);
      
      // Should only include abort marker and events after
      expect(coalesced.length).toBe(2);
      expect(coalesced[0]?.seq).toBe(3); // Abort marker
      expect(coalesced[1]?.seq).toBe(4); // Message after abort
    });

    it('should preserve all events if no abort marker', () => {
      const events: UnifiedEvent[] = [
        {
          conversation: 1,
          turn: 1,
          event: 1,
          type: 'message',
          payload: { text: 'Hello' },
          finality: 'none',
          ts: '2024-01-01T00:00:00Z',
          agentId: 'agent-a',
          seq: 1
        },
        {
          conversation: 1,
          turn: 1,
          event: 2,
          type: 'message',
          payload: { text: 'Done' },
          finality: 'turn',
          ts: '2024-01-01T00:00:01Z',
          agentId: 'agent-a',
          seq: 2
        }
      ];

      const coalesced = coalesceEvents(events);
      
      // Should include all events
      expect(coalesced.length).toBe(2);
      expect(coalesced[0]?.seq).toBe(1);
      expect(coalesced[1]?.seq).toBe(2);
    });

    it('should not coalesce turn 0 (system events)', () => {
      const events: UnifiedEvent[] = [
        {
          conversation: 1,
          turn: 0,
          event: 1,
          type: 'system',
          payload: { kind: 'meta_created', metadata: {} },
          finality: 'none',
          ts: '2024-01-01T00:00:00Z',
          agentId: 'system',
          seq: 1
        },
        {
          conversation: 1,
          turn: 0,
          event: 2,
          type: 'trace',
          payload: { type: 'turn_cleared', abortedBy: 'system', timestamp: '2024-01-01T00:00:01Z' },
          finality: 'none',
          ts: '2024-01-01T00:00:01Z',
          agentId: 'system',
          seq: 2
        },
        {
          conversation: 1,
          turn: 0,
          event: 3,
          type: 'system',
          payload: { kind: 'note', data: 'test' },
          finality: 'none',
          ts: '2024-01-01T00:00:02Z',
          agentId: 'system',
          seq: 3
        }
      ];

      const coalesced = coalesceEvents(events);
      
      // Should include all turn 0 events
      expect(coalesced.length).toBe(3);
    });

    it('should use last abort marker when multiple exist', () => {
      const events: UnifiedEvent[] = [
        {
          conversation: 1,
          turn: 1,
          event: 1,
          type: 'message',
          payload: { text: 'First' },
          finality: 'none',
          ts: '2024-01-01T00:00:00Z',
          agentId: 'agent-a',
          seq: 1
        },
        {
          conversation: 1,
          turn: 1,
          event: 2,
          type: 'trace',
          payload: { type: 'turn_cleared', abortedBy: 'agent-a', timestamp: '2024-01-01T00:00:01Z' },
          finality: 'none',
          ts: '2024-01-01T00:00:01Z',
          agentId: 'agent-a',
          seq: 2
        },
        {
          conversation: 1,
          turn: 1,
          event: 3,
          type: 'message',
          payload: { text: 'Second' },
          finality: 'none',
          ts: '2024-01-01T00:00:02Z',
          agentId: 'agent-a',
          seq: 3
        },
        {
          conversation: 1,
          turn: 1,
          event: 4,
          type: 'trace',
          payload: { type: 'turn_cleared', abortedBy: 'agent-a', timestamp: '2024-01-01T00:00:03Z' },
          finality: 'none',
          ts: '2024-01-01T00:00:03Z',
          agentId: 'agent-a',
          seq: 4
        },
        {
          conversation: 1,
          turn: 1,
          event: 5,
          type: 'message',
          payload: { text: 'Final' },
          finality: 'turn',
          ts: '2024-01-01T00:00:04Z',
          agentId: 'agent-a',
          seq: 5
        }
      ];

      const coalesced = coalesceEvents(events);
      
      // Should only include last abort and events after
      expect(coalesced.length).toBe(2);
      expect(coalesced[0]?.seq).toBe(4); // Last abort marker
      expect(coalesced[1]?.seq).toBe(5); // Final message
    });
  });

  describe('coalesceTurns', () => {
    it('should group coalesced events by turn', () => {
      const events: UnifiedEvent[] = [
        {
          conversation: 1,
          turn: 1,
          event: 1,
          type: 'message',
          payload: { text: 'Turn 1' },
          finality: 'turn',
          ts: '2024-01-01T00:00:00Z',
          agentId: 'agent-a',
          seq: 1
        },
        {
          conversation: 1,
          turn: 2,
          event: 1,
          type: 'message',
          payload: { text: 'Turn 2 attempt 1' },
          finality: 'none',
          ts: '2024-01-01T00:00:01Z',
          agentId: 'agent-b',
          seq: 2
        },
        {
          conversation: 1,
          turn: 2,
          event: 2,
          type: 'trace',
          payload: { type: 'turn_cleared', abortedBy: 'agent-b', timestamp: '2024-01-01T00:00:02Z' },
          finality: 'none',
          ts: '2024-01-01T00:00:02Z',
          agentId: 'agent-b',
          seq: 3
        },
        {
          conversation: 1,
          turn: 2,
          event: 3,
          type: 'message',
          payload: { text: 'Turn 2 attempt 2' },
          finality: 'turn',
          ts: '2024-01-01T00:00:03Z',
          agentId: 'agent-b',
          seq: 4
        }
      ];

      const turns = coalesceTurns(events);
      
      // Should have 2 turns
      expect(turns.size).toBe(2);
      
      // Turn 1 should have all events (no abort)
      expect(turns.get(1)?.length).toBe(1);
      
      // Turn 2 should only have abort and after
      expect(turns.get(2)?.length).toBe(2);
      expect(turns.get(2)?.[0]?.seq).toBe(3); // Abort marker
      expect(turns.get(2)?.[1]?.seq).toBe(4); // Final message
    });
  });
});