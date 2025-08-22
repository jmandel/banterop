// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseAgent, type TurnContext, type TurnRecoveryMode } from './base-agent';
import type { IAgentTransport, IAgentEvents } from './runtime.interfaces';
import type { GuidanceEvent } from '$src/types/orchestrator.types';

// Mock transport implementation
class MockTransport implements IAgentTransport {
  getSnapshot = vi.fn();
  postMessage = vi.fn();
  postTrace = vi.fn();
  clearTurn = vi.fn();
  createEventStream = vi.fn();
  now = vi.fn().mockReturnValue(Date.now());
}

// Test agent implementation
class TestAgent extends BaseAgent {
  takeTurnCalls: TurnContext[] = [];
  
  constructor(
    transport: IAgentTransport,
    options?: { turnRecoveryMode?: TurnRecoveryMode }
  ) {
    super(transport, options);
  }
  
  protected async takeTurn(ctx: TurnContext): Promise<void> {
    this.takeTurnCalls.push(ctx);
    // Simulate some work
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('BaseAgent reconcile-first pattern', () => {
  let transport: MockTransport;
  let agent: TestAgent;
  let mockEventStream: IAgentEvents;
  let eventListeners: ((event: any) => void)[] = [];

  beforeEach(() => {
    transport = new MockTransport();
    eventListeners = [];
    
    // Mock event stream
    mockEventStream = {
      subscribe: vi.fn((listener: (event: any) => void) => {
        eventListeners.push(listener);
        return () => {
          const idx = eventListeners.indexOf(listener);
          if (idx >= 0) eventListeners.splice(idx, 1);
        };
      }),
    };
    
    transport.createEventStream.mockReturnValue(mockEventStream);
    transport.clearTurn.mockResolvedValue({ turn: 1 });
  });

  const createSnapshot = (events: any[] = [], status = 'active', lastClosedSeq = 0) => ({
    events,
    status,
    lastClosedSeq,
    metadata: { agents: [] }
  });

  const emitGuidance = (agentId: string, seq = 1, kind: 'start_turn'|'continue_turn' = 'continue_turn', turn = 1) => {
    const guidance: GuidanceEvent = {
      type: 'guidance',
      nextAgentId: agentId,
      seq,
      kind,
      turn,
      deadlineMs: Date.now() + 30000,
      conversation: 1
    };
    eventListeners.forEach(listener => listener(guidance));
  };

  // Removed: orchestrator does not emit guidance mid-turn; base agent keeps only a single
  // pending guidance slot and drops it if it just closed its own turn.

  // Note: We intentionally do not test mid-turn guidance behavior, since the orchestrator
  // never emits guidance while a turn is in progress, and any pending guidance is best-effort
  // timing-dependent. Deterministic guidance semantics are exercised in other tests.

  describe('turn recovery modes', () => {
    it('should resume open turn with resume mode upon continue guidance', async () => {
      agent = new TestAgent(transport, { turnRecoveryMode: 'resume' });
      
      // Setup snapshot with open turn owned by this agent
      const snapshot = createSnapshot([
        { type: 'message', agentId: 'test-agent', finality: 'none', seq: 1 }
      ]);
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      await agent.start(1, 'test-agent');
      // Guidance instructs us to continue current open turn
      emitGuidance('test-agent', 1, 'continue_turn', 1);
      
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(agent.takeTurnCalls).toHaveLength(1);
      expect(transport.clearTurn).not.toHaveBeenCalled();
    });

    it('should restart open turn with restart mode upon continue guidance', async () => {
      agent = new TestAgent(transport, { turnRecoveryMode: 'restart' });
      
      // Setup snapshot with open turn owned by this agent
      const snapshot = createSnapshot([
        { type: 'message', agentId: 'test-agent', finality: 'none', seq: 1 }
      ]);
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      await agent.start(1, 'test-agent');
      // Guidance instructs us to continue current open turn
      emitGuidance('test-agent', 1, 'continue_turn', 1);
      
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(transport.clearTurn).toHaveBeenCalledWith(1, 'test-agent');
      expect(agent.takeTurnCalls).toHaveLength(1);
    });

    it('should not act when another agent owns the open turn', async () => {
      agent = new TestAgent(transport);
      
      // Setup snapshot with open turn owned by different agent
      const snapshot = createSnapshot([
        { type: 'message', agentId: 'other-agent', finality: 'none', seq: 1 }
      ]);
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      await agent.start(1, 'test-agent');
      
      // Should not take turn
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(agent.takeTurnCalls).toHaveLength(0);
      expect(transport.clearTurn).not.toHaveBeenCalled();
    });
  });

  describe('lastProcessedClosedSeq tracking', () => {
    it('should act on repeated guidance even if lastClosedSeq unchanged (orchestrator source of truth)', async () => {
      agent = new TestAgent(transport);
      
      // Initial snapshot
      const snapshot = createSnapshot([], 'active', 5);
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      await agent.start(1, 'test-agent');
      
      // First guidance
      emitGuidance('test-agent', 1, 'start_turn', 1);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(agent.takeTurnCalls).toHaveLength(1);
      
      // Wait for turn to complete
      await new Promise(resolve => setTimeout(resolve, 20));
      
      // Second guidance with same lastClosedSeq
      emitGuidance('test-agent', 2, 'start_turn', 2);
      await new Promise(resolve => setTimeout(resolve, 20));
      
      // New base agent executes when orchestrator guides (no local gating)
      expect(agent.takeTurnCalls).toHaveLength(2);
    });

    it('should act on guidance when lastClosedSeq advances', async () => {
      agent = new TestAgent(transport);
      
      // Initial snapshot
      let snapshot = createSnapshot([], 'active', 5);
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      await agent.start(1, 'test-agent');
      
      // First guidance
      emitGuidance('test-agent', 1);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(agent.takeTurnCalls).toHaveLength(1);
      
      // Update snapshot with advanced lastClosedSeq
      snapshot = createSnapshot(
        [{ type: 'message', agentId: 'test-agent', finality: 'turn', seq: 6 }],
        'active',
        6
      );
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      // Second guidance with new lastClosedSeq
      emitGuidance('test-agent', 2);
      await new Promise(resolve => setTimeout(resolve, 30));
      
      // Should trigger another turn (new lastClosedSeq)
      expect(agent.takeTurnCalls).toHaveLength(2);
    });
  });

  describe('startup reconciliation', () => {
    it('should reconcile on startup without guidance', async () => {
      agent = new TestAgent(transport);
      
      // Setup snapshot indicating it's our turn (no open turn, we should start)
      const snapshot = createSnapshot([
        { type: 'message', agentId: 'other-agent', finality: 'turn', seq: 1 }
      ]);
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      // Start agent - should reconcile but not act (no guidance targeting us)
      await agent.start(1, 'test-agent');
      await new Promise(resolve => setTimeout(resolve, 20));
      
      // Should not take turn without guidance
      expect(agent.takeTurnCalls).toHaveLength(0);
    });

    it('should resume/restart open turn on startup based on policy when guided', async () => {
      agent = new TestAgent(transport, { turnRecoveryMode: 'restart' });
      
      // Setup snapshot with our open turn
      const snapshot = createSnapshot([
        { type: 'message', agentId: 'test-agent', finality: 'none', seq: 1 }
      ]);
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      // Start agent then receive continue_turn guidance
      await agent.start(1, 'test-agent');
      emitGuidance('test-agent', 1, 'continue_turn', 1);
      await new Promise(resolve => setTimeout(resolve, 20));
      
      // Should abort and restart
      expect(transport.clearTurn).toHaveBeenCalledWith(1, 'test-agent');
      expect(agent.takeTurnCalls).toHaveLength(1);
    });
  });

  describe('conversation completion', () => {
    it('should not act without guidance; guidance may still trigger a turn even if snapshot says completed', async () => {
      agent = new TestAgent(transport);
      
      // Setup completed conversation
      const snapshot = createSnapshot([], 'completed');
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      await agent.start(1, 'test-agent');
      await new Promise(resolve => setTimeout(resolve, 20));
      
      // Should not take any turns without guidance
      expect(agent.takeTurnCalls).toHaveLength(0);
      
      // Emit guidance - new base agent defers to orchestrator and will act
      emitGuidance('test-agent', 1, 'start_turn', 1);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(agent.takeTurnCalls).toHaveLength(1);
    });
  });
});
