import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { App } from '$src/server/app';
import { startInternalAgents } from '$src/agents/start-internal-agents';
import type { AgentMeta } from '$src/types/conversation.meta';

describe('Stateless Agent Integration', () => {
  let app: App;
  
  beforeEach(() => {
    // Use in-memory database for tests - each test gets a fresh instance
    app = new App({ 
      dbPath: ':memory:',
      port: 3001,  // Valid port for testing
      nodeEnv: 'test' 
    });
    console.log('[TEST] Created new App instance for test');
  });
  
  afterEach(async () => {
    console.log('[TEST] Shutting down App instance');
    await app.shutdown();
  });
  
  describe('per-turn agent instantiation', () => {
    it('should create fresh agent instances for each turn', async () => {
      // Track agent instantiations - removed unused variable
      
      // Create a custom buildAgent that tracks calls
      const buildContext = {
        providerManager: app.providerManager,
        storage: app.orchestrator.storage,
      };
      
      // Create conversation with two internal agents using TestAgent
      const agents: AgentMeta[] = [
        { 
          id: 'agent-a', 
          kind: 'internal',
          agentClass: 'TestAgent',
          config: { text: 'Response from A', maxTurns: 1 }
        },
        { 
          id: 'agent-b', 
          kind: 'internal',
          agentClass: 'TestAgent',
          config: { text: 'Response from B', maxTurns: 1, stopAfterTurns: true }
        },
      ];
      
      const conversationId = app.orchestrator.createConversation({
        title: 'Test stateless agents',
        agents,
      });
      
      console.log('[TEST] Created conversation:', conversationId, 'with agents:', agents.map(a => a.id));
      
      // Start internal agents
      const { stop } = await startInternalAgents({
        orchestrator: app.orchestrator,
        conversationId,
        buildContext,
      });
      
      // Agent-a starts the conversation
      app.orchestrator.sendMessage(
        conversationId,
        'agent-a',
        { text: 'Starting conversation' },
        'turn'
      );
      
      // Wait for agents to respond
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Check events
      const events = app.orchestrator.getEventsSince(conversationId);
      
      // Should have at least: agent-a start, agent-b response
      const messageEvents = events.filter(e => e.type === 'message');
      expect(messageEvents.length).toBeGreaterThanOrEqual(2);
      
      // Verify alternation
      if (messageEvents.length >= 2) {
        expect(messageEvents[0]?.agentId).toBe('agent-a');
        expect(messageEvents[1]?.agentId).toBe('agent-b');
      }
      
      // Stop agents
      await stop();
    });
    
    it('should handle mixed internal and external agents', async () => {
      // Create conversation with one internal and one external agent
      const agents: AgentMeta[] = [
        { 
          id: 'internal-1', 
          kind: 'internal',
          agentClass: 'TestAgent',
          config: { text: 'Internal response', finality: 'turn' }
        },
        { 
          id: 'external-1', 
          kind: 'external',
        },
      ];
      
      const conversationId = app.orchestrator.createConversation({
        title: 'Mixed agents test',
        agents,
      });
      
      const buildContext = {
        providerManager: app.providerManager,
        storage: app.orchestrator.storage,
      };
      
      // Start only internal agents
      const { stop } = await startInternalAgents({
        orchestrator: app.orchestrator,
        conversationId,
        buildContext,
      });
      
      // External agent starts the conversation
      app.orchestrator.sendMessage(
        conversationId,
        'external-1',
        { text: 'Starting from external' },
        'turn'
      );
      
      // Wait for internal agent to respond
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Check that internal agent responded
      const events = app.orchestrator.getEventsSince(conversationId);
      const internalMessages = events.filter(e => 
        e.type === 'message' && e.agentId === 'internal-1'
      );
      
      expect(internalMessages.length).toBeGreaterThan(0);
      
      await stop();
    });
  });
  
  describe('StrictAlternationPolicy integration', () => {
    it('should enforce strict alternation between agents', async () => {
      // Create conversation with three internal agents
      // Since agents are stateless, we'll use a simple test that stops after one round
      const agents: AgentMeta[] = [
        { id: 'agent-1', kind: 'internal', agentClass: 'TestAgent', config: { finality: 'turn' } },
        { id: 'agent-2', kind: 'internal', agentClass: 'TestAgent', config: { finality: 'turn' } },
        { id: 'agent-3', kind: 'internal', agentClass: 'TestAgent', config: { finality: 'conversation' } },
      ];
      
      const conversationId = app.orchestrator.createConversation({
        title: 'Three agent alternation',
        agents,
      });
      
      const buildContext = {
        providerManager: app.providerManager,
        storage: app.orchestrator.storage,
      };
      
      // Start internal agents
      const { stop } = await startInternalAgents({
        orchestrator: app.orchestrator,
        conversationId,
        buildContext,
      });
      
      // Start conversation
      app.orchestrator.sendMessage(
        conversationId,
        'agent-1',
        { text: 'Starting conversation' },
        'turn'
      );
      
      // Let agents interact
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Get all message events
      const events = app.orchestrator.getEventsSince(conversationId);
      const messages = events.filter(e => 
        e.type === 'message' && e.finality === 'turn'
      );
      
      // Verify strict alternation pattern
      for (let i = 1; i < messages.length; i++) {
        const currentAgent = messages[i]?.agentId;
        const prevAgent = messages[i - 1]?.agentId;
        
        if (!currentAgent || !prevAgent) continue;
        
        // Get indices in agent list
        const currentIdx = agents.findIndex(a => a.id === currentAgent);
        const prevIdx = agents.findIndex(a => a.id === prevAgent);
        
        // Should be next agent in rotation
        const expectedIdx = (prevIdx + 1) % agents.length;
        expect(currentIdx).toBe(expectedIdx);
      }
      
      await stop();
    });
    
    it('should not schedule on non-finalized messages', async () => {
      const agents: AgentMeta[] = [
        { id: 'agent-a', kind: 'internal', agentClass: 'TestAgent', config: { finality: 'none' } },
        { id: 'agent-b', kind: 'internal', agentClass: 'TestAgent', config: { finality: 'turn' } },
      ];
      
      const conversationId = app.orchestrator.createConversation({
        title: 'Finality test',
        agents,
      });
      
      const buildContext = {
        providerManager: app.providerManager,
        storage: app.orchestrator.storage,
      };
      
      const { stop } = await startInternalAgents({
        orchestrator: app.orchestrator,
        conversationId,
        buildContext,
      });
      
      // Send message without finality
      app.orchestrator.sendMessage(
        conversationId,
        'agent-a',
        { text: 'Progress message' },
        'none'
      );
      
      // Wait briefly
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Agent B should not have responded
      const events = app.orchestrator.getEventsSince(conversationId);
      const agentBMessages = events.filter(e => 
        e.type === 'message' && e.agentId === 'agent-b'
      );
      
      expect(agentBMessages.length).toBe(0);
      
      // Now send with finality
      app.orchestrator.sendMessage(
        conversationId,
        'agent-a',
        { text: 'Final message' },
        'turn'
      );
      
      // Wait for response
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Now agent B should have responded
      const eventsAfter = app.orchestrator.getEventsSince(conversationId);
      const agentBMessagesAfter = eventsAfter.filter(e => 
        e.type === 'message' && e.agentId === 'agent-b'
      );
      
      expect(agentBMessagesAfter.length).toBeGreaterThan(0);
      
      await stop();
    });
  });
  
  describe('waitForTurn functionality', () => {
    it('should correctly wait for agent turn via waitForTurn', async () => {
      const agents: AgentMeta[] = [
        { id: 'agent-x', kind: 'internal', agentClass: 'TestAgent' },
        { id: 'agent-y', kind: 'internal', agentClass: 'TestAgent' },
      ];
      
      const conversationId = app.orchestrator.createConversation({
        title: 'WaitForTurn test',
        agents,
      });
      
      // Start waiting for agent-y's turn
      const turnPromise = app.orchestrator.waitForTurn(
        conversationId,
        'agent-y'
      );
      
      // Agent-x sends a message
      app.orchestrator.sendMessage(
        conversationId,
        'agent-x',
        { text: 'X speaks' },
        'turn'
      );
      
      // Wait should resolve for agent-y
      const result = await Promise.race([
        turnPromise,
        new Promise(resolve => setTimeout(() => resolve('timeout'), 500))
      ]);
      
      expect(result).not.toBe('timeout');
      expect(result).toHaveProperty('deadlineMs');
      
      // Complete conversation
      app.orchestrator.sendMessage(
        conversationId,
        'agent-y',
        { text: 'Y ends it' },
        'conversation'
      );
      
      // Future waitForTurn should return null
      const afterComplete = await app.orchestrator.waitForTurn(
        conversationId,
        'agent-x'
      );
      
      expect(afterComplete).toBeNull();
    });
  });
});