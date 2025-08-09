import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseAgent, type TurnContext, type TurnRecoveryMode } from './base-agent';
import type { IAgentTransport, IAgentEvents } from './runtime.interfaces';
import type { GuidanceEvent } from '$src/types/orchestrator.types';

// Mock transport implementation
class MockTransport implements IAgentTransport {
  getSnapshot = vi.fn();
  postMessage = vi.fn();
  postTrace = vi.fn();
  abortTurn = vi.fn();
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
    transport.abortTurn.mockResolvedValue({ turn: 1 });
  });

  const createSnapshot = (events: any[] = [], status = 'active', lastClosedSeq = 0) => ({
    events,
    status,
    lastClosedSeq,
    metadata: { agents: [] }
  });

  const emitGuidance = (agentId: string, seq = 1) => {
    const guidance: GuidanceEvent = {
      type: 'guidance',
      nextAgentId: agentId,
      seq,
      deadlineMs: Date.now() + 30000,
      conversation: 1
    };
    eventListeners.forEach(listener => listener(guidance));
  };

  describe('guidance handling during turn execution', () => {
    it('should ignore guidance while actively executing a turn (inTurn=true)', async () => {
      agent = new TestAgent(transport);
      
      // Setup initial snapshot
      const snapshot = createSnapshot();
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      await agent.start(1, 'test-agent');
      
      // First guidance triggers turn
      emitGuidance('test-agent', 1);
      await new Promise(resolve => setTimeout(resolve, 5));
      
      expect(agent.takeTurnCalls).toHaveLength(1);
      
      // While turn is running, emit another guidance
      emitGuidance('test-agent', 2);
      await new Promise(resolve => setTimeout(resolve, 5));
      
      // Should still only have one turn call (ignored the second guidance)
      expect(agent.takeTurnCalls).toHaveLength(1);
      expect(transport.abortTurn).not.toHaveBeenCalled();
    });
  });

  describe('turn recovery modes', () => {
    it('should resume open turn with resume mode', async () => {
      agent = new TestAgent(transport, { turnRecoveryMode: 'resume' });
      
      // Setup snapshot with open turn owned by this agent
      const snapshot = createSnapshot([
        { type: 'message', agentId: 'test-agent', finality: 'none', seq: 1 }
      ]);
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      await agent.start(1, 'test-agent');
      
      // Should resume without abort
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(agent.takeTurnCalls).toHaveLength(1);
      expect(transport.abortTurn).not.toHaveBeenCalled();
    });

    it('should restart open turn with restart mode', async () => {
      agent = new TestAgent(transport, { turnRecoveryMode: 'restart' });
      
      // Setup snapshot with open turn owned by this agent
      const snapshot = createSnapshot([
        { type: 'message', agentId: 'test-agent', finality: 'none', seq: 1 }
      ]);
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      await agent.start(1, 'test-agent');
      
      // Should abort then start fresh
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(transport.abortTurn).toHaveBeenCalledWith(1, 'test-agent');
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
      expect(transport.abortTurn).not.toHaveBeenCalled();
    });
  });

  describe('lastProcessedClosedSeq tracking', () => {
    it('should ignore repeated guidance with same lastClosedSeq', async () => {
      agent = new TestAgent(transport);
      
      // Initial snapshot
      const snapshot = createSnapshot([], 'active', 5);
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      await agent.start(1, 'test-agent');
      
      // First guidance
      emitGuidance('test-agent', 1);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(agent.takeTurnCalls).toHaveLength(1);
      
      // Wait for turn to complete
      await new Promise(resolve => setTimeout(resolve, 20));
      
      // Second guidance with same lastClosedSeq
      emitGuidance('test-agent', 2);
      await new Promise(resolve => setTimeout(resolve, 20));
      
      // Should not trigger another turn (same lastClosedSeq)
      expect(agent.takeTurnCalls).toHaveLength(1);
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

    it('should resume/restart open turn on startup based on policy', async () => {
      agent = new TestAgent(transport, { turnRecoveryMode: 'restart' });
      
      // Setup snapshot with our open turn
      const snapshot = createSnapshot([
        { type: 'message', agentId: 'test-agent', finality: 'none', seq: 1 }
      ]);
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      // Start agent
      await agent.start(1, 'test-agent');
      await new Promise(resolve => setTimeout(resolve, 20));
      
      // Should abort and restart
      expect(transport.abortTurn).toHaveBeenCalledWith(1, 'test-agent');
      expect(agent.takeTurnCalls).toHaveLength(1);
    });
  });

  describe('conversation completion', () => {
    it('should stop when conversation is completed', async () => {
      agent = new TestAgent(transport);
      
      // Setup completed conversation
      const snapshot = createSnapshot([], 'completed');
      transport.getSnapshot.mockResolvedValue(snapshot);
      
      await agent.start(1, 'test-agent');
      await new Promise(resolve => setTimeout(resolve, 20));
      
      // Should not take any turns
      expect(agent.takeTurnCalls).toHaveLength(0);
      
      // Emit guidance - should be ignored
      emitGuidance('test-agent', 1);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(agent.takeTurnCalls).toHaveLength(0);
    });
  });
});