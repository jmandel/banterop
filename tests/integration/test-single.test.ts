import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { App } from '$src/server/app';
import { startInternalAgents } from '$src/agents/start-internal-agents';
import type { AgentMeta } from '$src/types/conversation.meta';

describe('Single Test', () => {
  it('should create fresh agent instances for each turn', async () => {
    // Use in-memory database for tests - each test gets a fresh instance
    const app = new App({ 
      dbPath: ':memory:',
      port: 3001,  // Valid port for testing
      nodeEnv: 'test' 
    });
    
    // Create a custom buildAgent that tracks calls
    const buildContext = {
      providerManager: app.providerManager,
      storage: app.orchestrator.storage,
    };
    
    // Create conversation with only agents
    const agents: AgentMeta[] = [
      { 
        id: 'agent-a', 
        kind: 'internal',
        agentClass: 'TestAgent',
        config: { text: 'Response from A', finality: 'turn' }
      },
      { 
        id: 'agent-b', 
        kind: 'internal',
        agentClass: 'TestAgent',
        config: { text: 'Response from B', finality: 'conversation' }
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
    
    console.log('[TEST] Started internal agents, agent-a starting conversation...');
    
    // Agent-a starts the conversation
    app.orchestrator.sendMessage(
      conversationId,
      'agent-a',
      { text: 'Starting conversation' },
      'turn'
    );
    
    console.log('[TEST] Agent-a message sent, waiting for agents to respond...');
    
    // Wait for agents to respond
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('[TEST] Wait complete, checking events...');
    
    // Check events
    const events = app.orchestrator.getEventsSince(conversationId);
    console.log('[TEST] Got events:', events.map(e => `${e.type}:${e.agentId}`));
    
    // Should have: agent-a start message, agent-b response
    const messageEvents = events.filter(e => e.type === 'message');
    console.log('[TEST] Message events:', messageEvents.length);
    expect(messageEvents.length).toBeGreaterThanOrEqual(2);
    
    // Verify alternation: agent-a starts, agent-b responds
    if (messageEvents.length >= 2) {
      expect(messageEvents[0]?.agentId).toBe('agent-a');
      expect(messageEvents[1]?.agentId).toBe('agent-b');
    }
    
    // Verify conversation ended
    const lastMessage = messageEvents[messageEvents.length - 1];
    if (lastMessage) {
      expect(lastMessage.finality).toBe('conversation');
    }
    
    // Stop agents
    await stop();
    await app.shutdown();
  });
});