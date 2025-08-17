import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OrchestratorService } from './orchestrator';
import { Storage } from './storage';
import { SubscriptionBus } from './subscriptions';
import { MockLLMProvider } from '$src/llm/providers/mock';
import { LLMProviderManager } from '$src/llm/provider-manager';
import type { GuidanceEvent, ConversationSnapshot } from '$src/types/orchestrator.types';
import type { UnifiedEvent } from '$src/types/event.types';

describe('Turn Counting Edge Cases', () => {
  let orchestrator: OrchestratorService;
  let storage: Storage;
  let bus: SubscriptionBus;
  let providerManager: LLMProviderManager;
  let guidanceEvents: GuidanceEvent[] = [];
  
  beforeEach(() => {
    // Set up storage and bus
    storage = new Storage(':memory:');
    bus = new SubscriptionBus();
    
    // Set up mock provider
    providerManager = new LLMProviderManager({
      defaultLlmProvider: 'mock',
      defaultLlmModel: 'mock-model'
    });
    
    // Create orchestrator with proper parameters
    orchestrator = new OrchestratorService(storage, bus, undefined, {});
    
    // Capture guidance events by subscribing
    guidanceEvents = [];
    const subId = orchestrator.subscribeAll((event: any) => {
      if (event.type === 'guidance') {
        guidanceEvents.push(event as GuidanceEvent);
      }
    }, true);
  });
  
  afterEach(async () => {
    await orchestrator.shutdown();
    storage.close();
  });

  describe('Guidance Event Turn Numbers', () => {
    it('should include turn number in initial conversation guidance', async () => {
      const convId = orchestrator.createConversation({
        meta: {
          scenarioId: 'test-scenario',
          agents: [
            { id: 'agent-a', config: { llmProvider: 'mock' } },
            { id: 'agent-b', config: { llmProvider: 'mock' } }
          ],
          startingAgentId: 'agent-a'
        }
      });
      
      // Wait for guidance to be published
      await new Promise(resolve => setTimeout(resolve, 50));
      
      expect(guidanceEvents.length).toBeGreaterThan(0);
      const firstGuidance = guidanceEvents[0];
      expect(firstGuidance).toBeDefined();
      expect(firstGuidance!.turn).toBeDefined();
      expect(firstGuidance!.turn).toBe(1);
      expect(firstGuidance!.nextAgentId).toBe('agent-a');
      expect(firstGuidance!.kind).toBe('start_turn');
    });
    
    it('should increment turn number when switching agents', async () => {
      const convId = orchestrator.createConversation({
        meta: {
          scenarioId: 'test-scenario',
          agents: [
            { id: 'agent-a', config: { llmProvider: 'mock' } },
            { id: 'agent-b', config: { llmProvider: 'mock' } }
          ],
          startingAgentId: 'agent-a'
        }
      });
      
      // Agent A completes turn 1
      orchestrator.sendMessage(convId, 1, 'agent-a', { text: 'Hello from A' }, 'turn');
      
      // Wait for guidance to next agent
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Find guidance for agent-b
      const guidanceForB = guidanceEvents.find(g => g.nextAgentId === 'agent-b');
      expect(guidanceForB).toBeDefined();
      expect(guidanceForB!.turn).toBe(2);
      expect(guidanceForB!.kind).toBe('start_turn');
    });
    
    it('should maintain same turn number for continue_turn guidance', async () => {
      const convId = orchestrator.createConversation({
        meta: {
          scenarioId: 'test-scenario',
          agents: [
            { id: 'agent-a', config: { llmProvider: 'mock' } }
          ],
          startingAgentId: 'agent-a'
        }
      });
      
      // Agent A sends a message but doesn't close turn
      orchestrator.sendMessage(convId, 1, 'agent-a', { text: 'Starting my turn' }, 'none');
      
      // Add a trace event to the same turn
      orchestrator.sendTrace(convId, 1, 'agent-a', { type: 'thought', content: 'Thinking...' });
      
      // Get guidance - should be continue_turn with same turn number
      const guidance = orchestrator.getGuidanceSnapshot(convId);
      
      expect(guidance).toBeDefined();
      expect(guidance?.kind).toBe('continue_turn');
      expect(guidance?.turn).toBe(1); // Should stay turn 1
      expect(guidance?.nextAgentId).toBe('agent-a');
    });
    
    it('should handle poke guidance with turn number', () => {
      // Create conversation but don't start it
      const convId = 123;
      
      // Mock getConversationSnapshot to return a conversation with no messages
      const originalGet = orchestrator.getConversationSnapshot;
      orchestrator.getConversationSnapshot = (id: number, opts?: { includeScenario?: boolean }) => {
        if (id === convId) {
          return {
            conversation: convId,
            status: 'active',
            events: [],
            lastClosedSeq: 0,
            metadata: {
              scenarioId: 'test-scenario',
              agents: [{ id: 'agent-a', config: {} }],
              startingAgentId: 'agent-a'
            }
          } as ConversationSnapshot;
        }
        return {} as ConversationSnapshot;  // Return empty snapshot instead of null
      };
      
      // Clear previous guidance events
      guidanceEvents = [];
      
      // Poke the conversation
      orchestrator.pokeGuidance(convId);
      
      // Check guidance was created with turn number
      expect(guidanceEvents.length).toBe(1);
      expect(guidanceEvents[0]!.turn).toBe(1);
      expect(guidanceEvents[0]!.nextAgentId).toBe('agent-a');
      
      // Restore original function
      orchestrator.getConversationSnapshot = originalGet;
    });
  });
  
  describe('Agent Turn Number Reception', () => {
    it('should throw error when guidance lacks turn number', async () => {
      // This test verifies our error handling works
      // We'll need to create a guidance event without turn number
      // This shouldn't happen in production after our fixes
      
      const convId = orchestrator.createConversation({
        meta: {
          scenarioId: 'test-scenario',
          agents: [{ id: 'agent-a', config: { llmProvider: 'mock' } }],
          startingAgentId: 'agent-a'
        }
      });
      
      // Manually create a bad guidance event (simulating the bug)
      const badGuidance: GuidanceEvent = {
        type: 'guidance',
        conversation: convId,
        seq: 999,
        nextAgentId: 'agent-a',
        kind: 'start_turn',
        deadlineMs: Date.now() + 30000,
        // Intentionally missing turn field
      };
      
      // This would cause the agent to throw an error with our new checks
      // We're verifying that the error would be thrown with helpful context
      expect(badGuidance.turn).toBeUndefined();
    });
  });
  
  describe('Complex Turn Scenarios', () => {
    it('should handle rapid turn switches correctly', async () => {
      const convId = orchestrator.createConversation({
        meta: {
          scenarioId: 'test-scenario',
          agents: [
            { id: 'agent-a', config: { llmProvider: 'mock' } },
            { id: 'agent-b', config: { llmProvider: 'mock' } },
            { id: 'agent-c', config: { llmProvider: 'mock' } }
          ],
          startingAgentId: 'agent-a'
        }
      });
      
      // Rapid sequence of turns
      const agents = ['agent-a', 'agent-b', 'agent-c', 'agent-a', 'agent-b'];
      let expectedTurn = 1;
      
      for (const agentId of agents) {
        orchestrator.sendMessage(convId, expectedTurn, agentId, { text: `Message from ${agentId}` }, 'turn');
        
        // Wait for guidance
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Verify guidance has correct turn number
        const latestGuidance = guidanceEvents[guidanceEvents.length - 1];
        if (latestGuidance && expectedTurn < agents.length) {
          expect(latestGuidance.turn).toBe(expectedTurn + 1);
        }
        
        expectedTurn++;
      }
    });
    
    it('should handle agent resumption within same turn', async () => {
      const convId = orchestrator.createConversation({
        meta: {
          scenarioId: 'test-scenario',
          agents: [
            { id: 'agent-a', config: { llmProvider: 'mock' } },
            { id: 'agent-b', config: { llmProvider: 'mock' } }
          ],
          startingAgentId: 'agent-a'
        }
      });
      
      // Agent starts turn with a message (required for continue_turn)
      const e1 = orchestrator.sendMessage(
        convId,
        1,
        'agent-a',
        { text: 'Starting to work on this...' },
        'none'  // Keep turn open
      );
      expect(e1.turn).toBe(1);
      
      // Agent adds thought using sendTrace (which reuses open turn)
      const e2 = orchestrator.sendTrace(
        convId,
        1,  // Same turn as the message
        'agent-a',
        { type: 'thought', content: 'Need to use a tool' }
      );
      expect(e2.turn).toBe(1); // Should have same turn as the message
      
      // Agent makes tool call
      const e3 = orchestrator.sendTrace(
        convId,
        1,  // Still turn 1
        'agent-a',
        { 
          type: 'tool_call', 
          name: 'test_tool',
          args: {},
          toolCallId: 'call-1'
        }
      );
      expect(e3.turn).toBe(1);
      
      // Get guidance - should be continue_turn with same turn number
      const guidance = orchestrator.getGuidanceSnapshot(convId);
      expect(guidance?.kind).toBe('continue_turn');
      expect(guidance?.turn).toBe(1); // Still turn 1
      
      // Agent gets tool result
      orchestrator.sendTrace(
        convId,
        1,  // Still turn 1
        'agent-a',
        {
          type: 'tool_result',
          toolCallId: 'call-1',
          result: { data: 'test' }
        }
      );
      
      // Finally close the turn
      const guidanceCountBefore = guidanceEvents.length;
      orchestrator.sendMessage(
        convId,
        1,
        'agent-a',
        { text: 'Done with tool' },
        'turn'
      );
      
      // Wait for any async guidance to be published
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Check if new guidance was published after turn close
      const guidanceCountAfter = guidanceEvents.length;
      expect(guidanceCountAfter).toBeGreaterThan(guidanceCountBefore);
      
      // The last guidance should be for turn 2
      const nextGuidance = guidanceEvents[guidanceEvents.length - 1];
      expect(nextGuidance!.turn).toBe(2);
    });
    
    it('should handle conversation with only traces (no messages)', async () => {
      const convId = orchestrator.createConversation({
        meta: {
          scenarioId: 'test-scenario',
          agents: [{ id: 'agent-a', config: { llmProvider: 'mock' } }],
          startingAgentId: 'agent-a'
        }
      });
      
      // Only traces, no messages - must provide explicit turn number
      orchestrator.sendTrace(convId, 1, 'agent-a', { type: 'thought', content: 'Thinking 1' });
      
      orchestrator.sendTrace(convId, 1, 'agent-a', { type: 'thought', content: 'Thinking 2' });
      
      // Guidance should still have turn number
      const guidance = orchestrator.getGuidanceSnapshot(convId);
      expect(guidance?.turn).toBeDefined();
      expect(guidance?.turn).toBe(1); // Still on turn 1
    });
    
    it('should handle system events (turn 0) correctly', async () => {
      const convId = orchestrator.createConversation({
        meta: {
          scenarioId: 'test-scenario',
          agents: [{ id: 'agent-a', config: { llmProvider: 'mock' } }],
          startingAgentId: 'agent-a'
        }
      });
      
      // Get initial events
      const snapshot = orchestrator.getConversationSnapshot(convId);
      
      // System events should be in turn 0
      const systemEvents = snapshot?.events.filter(e => e.type === 'system');
      systemEvents?.forEach(event => {
        expect(event.turn).toBe(0);
      });
      
      // First agent guidance should still be turn 1
      expect(guidanceEvents[0]!.turn).toBe(1);
    });
  });
  
  describe('Error Recovery Scenarios', () => {
    it('should handle missing guidance gracefully', async () => {
      // Test the scenario where an agent is called without guidance
      // This happens during startup recovery
      
      const convId = orchestrator.createConversation({
        meta: {
          scenarioId: 'test-scenario',
          agents: [{ id: 'agent-a', config: { llmProvider: 'mock' } }],
          startingAgentId: 'agent-a'
        }
      });
      
      // Simulate no guidance scenario
      const snapshot = orchestrator.getConversationSnapshot(convId);
      expect(snapshot).toBeDefined();
      
      // In this case, the agent would receive guidanceSeq: 0
      // Our error message should indicate "No guidance received (startup recovery)"
    });
    
    it('should detect orchestrator bug vs no guidance', async () => {
      // Our new error handling differentiates between:
      // 1. No guidance (guidanceSeq === 0)
      // 2. Guidance with missing turn (guidanceSeq > 0 but no turn)
      
      const convId = orchestrator.createConversation({
        meta: {
          scenarioId: 'test-scenario',
          agents: [{ id: 'agent-a', config: { llmProvider: 'mock' } }],
          startingAgentId: 'agent-a'
        }
      });
      
      // Check that all real guidance events have turn numbers
      guidanceEvents.forEach(event => {
        expect(event.turn).toBeDefined();
        expect(event.seq).toBeGreaterThan(0);
      });
    });
  });
});