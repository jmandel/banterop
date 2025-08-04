import { expect, test, describe, afterEach } from 'bun:test';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { WebSocketJsonRpcClient } from '$client/impl/websocket.client.js';
import { MockLLMProvider, TestEnvironment } from '../utils/test-helpers.js';
import { ToolSynthesisService } from '$agents/services/tool-synthesis.service.js';
import { createAgent } from '$agents/factory.js';
import { ScenarioDrivenAgent } from '$agents/scenario-driven.agent.js';
import type { ScenarioDrivenAgentConfig, ScenarioConfiguration } from '$lib/types.js';

describe('Conversation Initiation Refactor', () => {
  let orchestrator: ConversationOrchestrator;
  let llmProvider: any;
  
  afterEach(async () => {
    orchestrator?.close();
  });

  test('internal conversations require start endpoint to be called', async () => {
    // Setup
    llmProvider = new MockLLMProvider();
    const toolSynthesis = new ToolSynthesisService(llmProvider);
    orchestrator = new ConversationOrchestrator(undefined, llmProvider, toolSynthesis);
      
    const { conversation } = await orchestrator.createConversation({
      metadata: { conversationTitle: 'Test Internal Conversation' },
      agents: [{
        id: "test-agent",
        strategyType: 'sequential_script',
        script: [{
          trigger: { type: 'conversation_ready' },
          steps: [{ type: 'response', content: 'Hello from test agent' }]
        }]
      }]
    });
      
    expect(conversation.status).toBe('created');
      
    await orchestrator.startConversation(conversation.id);
      
    const updated = orchestrator.getConversation(conversation.id, false, false);
    expect(updated.status).toBe('active');
  });

  test('external conversations reject start endpoint', async () => {
    // Setup
    llmProvider = new MockLLMProvider();
    const toolSynthesis = new ToolSynthesisService(llmProvider);
    orchestrator = new ConversationOrchestrator(undefined, llmProvider, toolSynthesis);
      
    const { conversation } = await orchestrator.createConversation({
      metadata: { conversationTitle: 'Test External Conversation' },
      agents: [{
        id: "test-agent",
        strategyType: 'external_websocket_client'
      }]
    });
      
    await expect(orchestrator.startConversation(conversation.id)).rejects.toThrow(
      'Cannot explicitly start an externally managed conversation. External conversations are activated by the first turn from a connected agent.'
    );
  });

  test('external conversations activate on first turn', async () => {
    // Setup test environment
    const testEnv = new TestEnvironment();
    await testEnv.start(3051);
      
    // Create conversation with only external agent
    const { conversation, agentTokens } = await testEnv.orchestrator.createConversation({
      metadata: { conversationTitle: 'Test External Conversation' },
      agents: [{
        id: "external-agent",
        strategyType: 'external_websocket_client'
      }]
    });
      
    expect(conversation.status).toBe('created');
      
    // Simulate external agent connecting and taking first turn
    const client = new WebSocketJsonRpcClient(`ws://localhost:3051/api/ws`);
    await client.connect();
    await client.authenticate(agentTokens['external-agent']);
    await client.subscribe(conversation.id);
    
    // External agent takes first turn - this should activate the conversation
    const turnId = await client.startTurn();
    await client.completeTurn(turnId, 'Hello from external agent');
      
    await new Promise(resolve => setTimeout(resolve, 100));
      
    const updated = testEnv.orchestrator.getConversation(conversation.id, false, false);
    expect(updated.status).toBe('active'); // Should be activated by first turn
      
    await client.disconnect();
    await testEnv.stop();
  });

  test('initializeConversation respects instructions', async () => {
    // Setup test environment
    const testEnv = new TestEnvironment();
    await testEnv.start(3052);
      
    const customMock = new MockLLMProvider();
    customMock.generateResponse = async (request: any) => {
      const prompt = request.messages[0].content;
      if (prompt.includes('INSTRUCTIONS FOR THIS CONVERSATION: Be very brief')) {
        return {
          content: '<scratchpad>I need to be very brief as instructed</scratchpad>\n```json\n{"name": "send_message_to_agent_conversation", "args": {"text": "Hi."}}\n```'
        };
      }
      return { content: 'Default response' };
    };
      
    const { conversation, agentTokens } = await testEnv.orchestrator.createConversation({
      metadata: { conversationTitle: 'Test Instructions' },
      agents: [{
        id: "test-agent",
        strategyType: 'scenario_driven',
        scenarioId: 'test-scenario'
      }]
    });
      
    const client = new WebSocketJsonRpcClient(`ws://localhost:3052/api/ws`);
      
    const mockScenario: ScenarioConfiguration = {
      metadata: {
        id: 'test-scenario',
        title: 'Test Scenario',
        description: 'Test scenario for initiation'
      },
      scenario: {
        background: 'Testing conversation initiation with custom instructions',
        challenges: ['Test challenge']
      },
      agents: [{
        agentId: "test-agent",
        principal: { type: 'individual', name: 'Test Principal', description: 'Test' },
        situation: 'Testing',
        systemPrompt: 'Be a test agent',
        goals: ['Test'],
        tools: [],
        knowledgeBase: {},
        messageToUseWhenInitiatingConversation: 'Hello, this is my default long message'
      }]
    };
    
    const agent = createAgent(
      {
        strategyType: 'scenario_driven',
        scenarioId: 'test-scenario',
        id: "test-agent"
      } as ScenarioDrivenAgentConfig,
      client,
      {
        db: testEnv.orchestrator.getDbInstance(),
        llmProvider: customMock,
        toolSynthesisService: new ToolSynthesisService(customMock),
        scenario: mockScenario
      }
    );
      
    await agent.initialize(conversation.id, agentTokens['test-agent']);
      
    let firstTurnContent = '';
    testEnv.orchestrator.subscribeToConversation(conversation.id, (event) => {
      if (event.type === 'turn_completed') {
        firstTurnContent = event.data.turn.content;
      }
    });
      
    await (agent as ScenarioDrivenAgent).initializeConversation('Be very brief');
      
    await new Promise(resolve => setTimeout(resolve, 100));
      
    expect(firstTurnContent).toBe('Hi.');
      
    await agent.shutdown();
    await client.disconnect();
    await testEnv.stop();
  });
});