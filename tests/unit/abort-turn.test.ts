import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
      meta: { agents: [{ id: 'agent-a' }, { id: 'agent-b' }] } 
    });
  });

  afterEach(async () => {
    await app.shutdown();
  });

  describe('clearTurn', () => {
    it('should add abort marker for open turn owned by agent', () => {
      // Agent A starts a turn
      orchestrator.sendMessage(conversationId, 1, 'agent-a', { text: 'Hello' }, 'none');
      
      // Agent A aborts
      const result = orchestrator.clearTurn(conversationId, 'agent-a');
      
      // Should return same turn
      expect(result.turn).toBe(1);
      
      // Check that abort marker was added
      const events = orchestrator.getConversationSnapshot(conversationId).events;
      const lastEvent = events[events.length - 1];
      expect(lastEvent?.type).toBe('trace');
      expect(lastEvent?.agentId).toBe('agent-a');
      expect((lastEvent?.payload as any)?.type).toBe('turn_cleared');
    });

    it('should be idempotent - not write another abort if already aborted', () => {
      // Agent A starts and aborts
      orchestrator.sendMessage(conversationId, 1, 'agent-a', { text: 'Hello' }, 'none');
      orchestrator.clearTurn(conversationId, 'agent-a');
      
      const eventCount = orchestrator.getConversationSnapshot(conversationId).events.length;
      
      // Abort again
      const result = orchestrator.clearTurn(conversationId, 'agent-a');
      
      // Should return same turn
      expect(result.turn).toBe(1);
      
      // No new event should be added
      const newEventCount = orchestrator.getConversationSnapshot(conversationId).events.length;
      expect(newEventCount).toBe(eventCount);
    });

    it('should return next turn for closed turn', () => {
      // Agent A completes a turn
      orchestrator.sendMessage(conversationId, 1, 'agent-a', { text: 'Hello' }, 'turn');
      
      // Agent A tries to abort (turn is closed)
      const result = orchestrator.clearTurn(conversationId, 'agent-a');
      
      // Should return next turn
      expect(result.turn).toBe(2);
      
      // No abort marker should be added
      const events = orchestrator.getConversationSnapshot(conversationId).events;
      const hasAbort = events.some(e => 
        e.type === 'trace' && (e.payload as any).type === 'turn_cleared'
      );
      expect(hasAbort).toBe(false);
    });

    it('should return next turn for wrong agent', () => {
      // Agent A starts a turn
      orchestrator.sendMessage(conversationId, 1, 'agent-a', { text: 'Hello' }, 'none');
      
      // Agent B tries to abort (wrong agent)
      const result = orchestrator.clearTurn(conversationId, 'agent-b');
      
      // Should return next turn
      expect(result.turn).toBe(2);
      
      // No abort marker should be added
      const events = orchestrator.getConversationSnapshot(conversationId).events;
      const hasAbort = events.some(e => 
        e.type === 'trace' && (e.payload as any).type === 'turn_cleared'
      );
      expect(hasAbort).toBe(false);
    });

    it('should allow continuing after abort', () => {
      // Agent A starts, aborts, and continues
      orchestrator.sendMessage(conversationId, 1, 'agent-a', { text: 'First try' }, 'none');
      const { turn } = orchestrator.clearTurn(conversationId, 'agent-a');
      
      // Continue work on same turn - must provide turn number
      const result = orchestrator.sendMessage(
        conversationId, 
        turn,  // Use the same turn that was cleared
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
      orchestrator.sendMessage(conversationId, 1, 'agent-a', { text: 'Hello' }, 'none');
      
      // Try to explicitly open turn 2 while turn 1 is open
      expect(() => {
        orchestrator.sendMessage(
          conversationId, 
          2, // Try to jump to turn 2
          'agent-b', 
          { text: 'Jump ahead' }, 
          'none'
        );
      }).toThrow('Turn already open');
    });

    it('should reject invalid turn number when no turn open', () => {
      // Complete turn 1
      orchestrator.sendMessage(conversationId, 1, 'agent-a', { text: 'Hello' }, 'turn');
      
      // Try to use wrong turn number
      expect(() => {
        orchestrator.sendMessage(
          conversationId, 
          5, // Invalid turn (should be 2)
          'agent-b', 
          { text: 'Wrong turn' }, 
          'none'
        );
      }).toThrow('Invalid turn number');
    });

    it('should continue open turn when providing same turn', () => {
      // Start turn
      const r1 = orchestrator.sendMessage(conversationId, 1, 'agent-a', { text: 'First' }, 'none');
      
      // Continue with same turn
      const r2 = orchestrator.sendMessage(conversationId, 1, 'agent-a', { text: 'Second' }, 'none');
      
      // Should be same turn
      expect(r2.turn).toBe(r1.turn);
    });

    it('should open new turn when providing next turn number', () => {
      // Complete turn 1
      orchestrator.sendMessage(conversationId, 1, 'agent-a', { text: 'Turn 1' }, 'turn');
      
      // Start new turn with explicit turn 2
      const result = orchestrator.sendMessage(conversationId, 2, 'agent-b', { text: 'Turn 2' }, 'none');
      
      // Should be turn 2
      expect(result.turn).toBe(2);
    });
  });

  describe('sendTrace', () => {
    it('should follow same turn validation rules as sendMessage', () => {
      // Start turn 1 with message first
      orchestrator.sendMessage(conversationId, 1, 'agent-a', { text: 'Starting' }, 'none');
      
      // Add trace to turn 1
      orchestrator.sendTrace(conversationId, 1, 'agent-a', { type: 'thought', content: 'Thinking...' });
      
      // Try to explicitly use turn 2 while turn 1 is open
      expect(() => {
        orchestrator.sendTrace(
          conversationId, 
          2, // Try to jump to turn 2
          'agent-b', 
          { type: 'thought', content: 'Jump ahead' }
        );
      }).toThrow('Turn already open');
    });

    it('should continue open turn when providing same turn number', () => {
      // Start turn with message
      const r1 = orchestrator.sendMessage(conversationId, 1, 'agent-a', { text: 'Hello' }, 'none');
      
      // Add trace with same turn number
      const r2 = orchestrator.sendTrace(conversationId, r1.turn, 'agent-a', { type: 'thought', content: 'Thinking...' });
      
      // Should be same turn
      expect(r2.turn).toBe(r1.turn);
    });
  });
});