import { describe, it, expect, beforeEach } from 'bun:test';
import { App } from '$src/server/app';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';

describe('Abort Turn Mechanism', () => {
  let app: App;
  let orchestrator: OrchestratorService;
  let conversationId: number;

  beforeEach(() => {
    app = new App({ dbPath: ':memory:' });
    orchestrator = app.orchestrator;
    conversationId = orchestrator.createConversation({ 
      meta: { agents: [{ id: 'agent-a', kind: 'internal' }, { id: 'agent-b', kind: 'external' }] } 
    });
  });

  describe('abortTurn', () => {
    it('should add abort marker for open turn owned by agent', () => {
      // Agent A starts a turn
      orchestrator.sendMessage(conversationId, 'agent-a', { text: 'Hello' }, 'none');
      
      // Agent A aborts
      const result = orchestrator.abortTurn(conversationId, 'agent-a');
      
      // Should return same turn
      expect(result.turn).toBe(1);
      
      // Check that abort marker was added
      const events = orchestrator.getConversationSnapshot(conversationId).events;
      const lastEvent = events[events.length - 1];
      expect(lastEvent?.type).toBe('trace');
      expect(lastEvent?.agentId).toBe('agent-a');
      expect((lastEvent?.payload as any)?.type).toBe('turn_aborted');
    });

    it('should be idempotent - not write another abort if already aborted', () => {
      // Agent A starts and aborts
      orchestrator.sendMessage(conversationId, 'agent-a', { text: 'Hello' }, 'none');
      orchestrator.abortTurn(conversationId, 'agent-a');
      
      const eventCount = orchestrator.getConversationSnapshot(conversationId).events.length;
      
      // Abort again
      const result = orchestrator.abortTurn(conversationId, 'agent-a');
      
      // Should return same turn
      expect(result.turn).toBe(1);
      
      // No new event should be added
      const newEventCount = orchestrator.getConversationSnapshot(conversationId).events.length;
      expect(newEventCount).toBe(eventCount);
    });

    it('should return next turn for closed turn', () => {
      // Agent A completes a turn
      orchestrator.sendMessage(conversationId, 'agent-a', { text: 'Hello' }, 'turn');
      
      // Agent A tries to abort (turn is closed)
      const result = orchestrator.abortTurn(conversationId, 'agent-a');
      
      // Should return next turn
      expect(result.turn).toBe(2);
      
      // No abort marker should be added
      const events = orchestrator.getConversationSnapshot(conversationId).events;
      const hasAbort = events.some(e => 
        e.type === 'trace' && (e.payload as any).type === 'turn_aborted'
      );
      expect(hasAbort).toBe(false);
    });

    it('should return next turn for wrong agent', () => {
      // Agent A starts a turn
      orchestrator.sendMessage(conversationId, 'agent-a', { text: 'Hello' }, 'none');
      
      // Agent B tries to abort (wrong agent)
      const result = orchestrator.abortTurn(conversationId, 'agent-b');
      
      // Should return next turn
      expect(result.turn).toBe(2);
      
      // No abort marker should be added
      const events = orchestrator.getConversationSnapshot(conversationId).events;
      const hasAbort = events.some(e => 
        e.type === 'trace' && (e.payload as any).type === 'turn_aborted'
      );
      expect(hasAbort).toBe(false);
    });

    it('should allow continuing after abort', () => {
      // Agent A starts, aborts, and continues
      orchestrator.sendMessage(conversationId, 'agent-a', { text: 'First try' }, 'none');
      const { turn } = orchestrator.abortTurn(conversationId, 'agent-a');
      
      // Continue work on same turn
      const result = orchestrator.sendMessage(
        conversationId, 
        'agent-a', 
        { text: 'Second try' }, 
        'turn'
      );
      
      // Should be same turn
      expect(result.turn).toBe(turn);
      expect(result.turn).toBe(1);
    });
  });

  describe('Turn enforcement', () => {
    it('should reject explicit turn when turn already open', () => {
      // Open turn 1
      orchestrator.sendMessage(conversationId, 'agent-a', { text: 'Hello' }, 'none');
      
      // Try to explicitly open turn 2 while turn 1 is open
      expect(() => {
        orchestrator.sendMessage(
          conversationId, 
          'agent-b', 
          { text: 'Jump ahead' }, 
          'none',
          2 // Explicit turn
        );
      }).toThrow('Turn already open');
    });

    it('should reject invalid turn number when no turn open', () => {
      // Complete turn 1
      orchestrator.sendMessage(conversationId, 'agent-a', { text: 'Hello' }, 'turn');
      
      // Try to use wrong turn number
      expect(() => {
        orchestrator.sendMessage(
          conversationId, 
          'agent-b', 
          { text: 'Wrong turn' }, 
          'none',
          5 // Invalid turn (should be 2)
        );
      }).toThrow('Invalid turn number');
    });

    it('should continue open turn when turn omitted', () => {
      // Start turn
      const r1 = orchestrator.sendMessage(conversationId, 'agent-a', { text: 'First' }, 'none');
      
      // Continue without specifying turn
      const r2 = orchestrator.sendMessage(conversationId, 'agent-a', { text: 'Second' }, 'none');
      
      // Should be same turn
      expect(r2.turn).toBe(r1.turn);
    });

    it('should open new turn when none open and turn omitted', () => {
      // Complete turn 1
      orchestrator.sendMessage(conversationId, 'agent-a', { text: 'Turn 1' }, 'turn');
      
      // Start new turn without specifying
      const result = orchestrator.sendMessage(conversationId, 'agent-b', { text: 'Turn 2' }, 'none');
      
      // Should be turn 2
      expect(result.turn).toBe(2);
    });
  });

  describe('sendTrace', () => {
    it('should follow same turn validation rules as sendMessage', () => {
      // Open turn 1 with trace
      orchestrator.sendTrace(conversationId, 'agent-a', { type: 'thought', content: 'Thinking...' });
      
      // Try to explicitly use turn 2 while turn 1 is open
      expect(() => {
        orchestrator.sendTrace(
          conversationId, 
          'agent-b', 
          { type: 'thought', content: 'Jump ahead' },
          2 // Explicit turn
        );
      }).toThrow('Turn already open');
    });

    it('should continue open turn when turn omitted', () => {
      // Start turn with message
      const r1 = orchestrator.sendMessage(conversationId, 'agent-a', { text: 'Hello' }, 'none');
      
      // Add trace without specifying turn
      const r2 = orchestrator.sendTrace(conversationId, 'agent-a', { type: 'thought', content: 'Thinking...' });
      
      // Should be same turn
      expect(r2.turn).toBe(r1.turn);
    });
  });
});