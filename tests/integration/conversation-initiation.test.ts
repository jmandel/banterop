import { expect, test, describe, afterEach } from 'bun:test';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { WebSocketJsonRpcClient } from '$client/impl/websocket.client.js';
import { MockLLMProvider, TestEnvironment } from '../utils/test-helpers.js';
import { ToolSynthesisService } from '$agents/services/tool-synthesis.service.js';
import { createAgent } from '$agents/factory.js';
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
    
    // Create internal conversation
    const { conversation } = await orchestrator.createConversation({
      name: 'Test Internal Conversation',
      managementMode: 'internal',
      initiatingAgentId: 'test-agent',
      initiatingInstructions: 'Be friendly',
      agents: [{
        agentId: { id: 'test-agent', label: 'Test Agent', role: 'assistant' },
        strategyType: 'sequential_script',
        script: [{
          trigger: { type: 'conversation_ready' },
          action: { type: 'send_message', text: 'Hello from test agent' }
        }]
      }]
    });
    
    // Verify status is 'created'
    expect(conversation.status).toBe('created');
    
    // Call start endpoint
    await orchestrator.startConversation(conversation.id);
    
    // Verify status is now 'active'
    const updated = orchestrator.getConversation(conversation.id, false, false);
    expect(updated.status).toBe('active');
  });

  test('external conversations reject start endpoint', async () => {
    // Setup
    llmProvider = new MockLLMProvider();
    const toolSynthesis = new ToolSynthesisService(llmProvider);
    orchestrator = new ConversationOrchestrator(undefined, llmProvider, toolSynthesis);
    
    // Create external conversation
    const { conversation } = await orchestrator.createConversation({
      name: 'Test External Conversation',
      managementMode: 'external',
      initiatingAgentId: 'test-agent',
      agents: [{
        agentId: { id: 'test-agent', label: 'Test Agent', role: 'assistant' },
        strategyType: 'sequential_script',
        script: [{
          trigger: { type: 'conversation_ready' },
          action: { type: 'send_message', text: 'Hello from test agent' }
        }]
      }]
    });
    
    // Attempt to call start endpoint - should throw
    await expect(orchestrator.startConversation(conversation.id)).rejects.toThrow(
      'Cannot explicitly start an externally managed conversation. External conversations are activated by the first turn from a connected agent.'
    );
  });

  test('external conversations activate on first turn', async () => {
    // Setup test environment
    const testEnv = new TestEnvironment();
    await testEnv.start(3051);
    
    // Create external conversation
    const { conversation, agentTokens } = await testEnv.orchestrator.createConversation({
      name: 'Test External Conversation',
      managementMode: 'external',
      initiatingAgentId: 'test-agent',
      agents: [{
        agentId: { id: 'test-agent', label: 'Test Agent', role: 'assistant' },
        strategyType: 'scenario_driven',
        scenarioId: 'test-scenario',
        role: 'TestRole'
      }]
    });
    
    // Verify initial status
    expect(conversation.status).toBe('created');
    
    // Connect external agent
    const client = new WebSocketJsonRpcClient(`ws://localhost:3051/api/ws`);
    
    // Create mock scenario
    const mockScenario: ScenarioConfiguration = {
      id: 'test-scenario',
      schemaVersion: '2.4',
      name: 'Test Scenario',
      description: 'Test scenario for initiation',
      principalIdentity: {
        domain: 'test.com',
        subdomain: 'unit-test'
      },
      scenarioMetadata: {
        createdBy: 'test',
        createdDate: new Date().toISOString()
      },
      agents: [{
        agentId: { id: 'test-agent', label: 'Test Agent', role: 'TestRole' },
        principal: { name: 'Test Principal', description: 'Test' },
        situation: 'Testing',
        systemPrompt: 'Be a test agent',
        goals: ['Test'],
        tools: [],
        messageToUseWhenInitiatingConversation: 'Hello, I am starting the conversation'
      }],
      patientAgent: {} as any,
      supplierAgent: {} as any,
      interactionDynamics: {} as any
    };
    
    const agent = createAgent(
      {
        strategyType: 'scenario_driven',
        scenarioId: 'test-scenario',
        agentId: { id: 'test-agent', label: 'Test Agent', role: 'TestRole' }
      } as ScenarioDrivenAgentConfig,
      client,
      {
        db: testEnv.orchestrator.getDbInstance(),
        llmProvider: new MockLLMProvider(),
        toolSynthesisService: new ToolSynthesisService(new MockLLMProvider()),
        scenario: mockScenario
      }
    );
    
    // Initialize agent connection
    await agent.initialize(conversation.id, agentTokens['test-agent']);
    
    // Agent calls initializeConversation (which internally sends first turn)
    await agent.initializeConversation('Please be concise');
    
    // Wait a bit for async operations
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify conversation is now active
    const updated = testEnv.orchestrator.getConversation(conversation.id, false, false);
    expect(updated.status).toBe('active');
    
    // Cleanup
    await agent.shutdown();
    await client.disconnect();
    await testEnv.stop();
  });

  test('initializeConversation respects instructions', async () => {
    // Setup test environment
    const testEnv = new TestEnvironment();
    await testEnv.start(3052);
    
    // Create custom mock for this test
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
    
    // Create conversation
    const { conversation, agentTokens } = await testEnv.orchestrator.createConversation({
      name: 'Test Instructions',
      managementMode: 'external',
      initiatingAgentId: 'test-agent',
      agents: [{
        agentId: { id: 'test-agent', label: 'Test Agent', role: 'assistant' },
        strategyType: 'scenario_driven',
        scenarioId: 'test-scenario',
        role: 'TestRole'
      }]
    });
    
    // Connect external agent
    const client = new WebSocketJsonRpcClient(`ws://localhost:3052/api/ws`);
    
    // Create mock scenario
    const mockScenario: ScenarioConfiguration = {
      id: 'test-scenario',
      schemaVersion: '2.4',
      name: 'Test Scenario',
      description: 'Test scenario for initiation',
      principalIdentity: {
        domain: 'test.com',
        subdomain: 'unit-test'
      },
      scenarioMetadata: {
        createdBy: 'test',
        createdDate: new Date().toISOString()
      },
      agents: [{
        agentId: { id: 'test-agent', label: 'Test Agent', role: 'TestRole' },
        principal: { name: 'Test Principal', description: 'Test' },
        situation: 'Testing',
        systemPrompt: 'Be a test agent',
        goals: ['Test'],
        tools: [],
        messageToUseWhenInitiatingConversation: 'Hello, this is my default long message'
      }],
      patientAgent: {} as any,
      supplierAgent: {} as any,
      interactionDynamics: {} as any
    };
    
    const agent = createAgent(
      {
        strategyType: 'scenario_driven',
        scenarioId: 'test-scenario',
        agentId: { id: 'test-agent', label: 'Test Agent', role: 'TestRole' }
      } as ScenarioDrivenAgentConfig,
      client,
      {
        db: testEnv.orchestrator.getDbInstance(),
        llmProvider: customMock,
        toolSynthesisService: new ToolSynthesisService(customMock),
        scenario: mockScenario
      }
    );
    
    // Initialize agent connection
    await agent.initialize(conversation.id, agentTokens['test-agent']);
    
    // Track events to capture the turn content
    let firstTurnContent = '';
    testEnv.orchestrator.subscribeToConversation(conversation.id, (event) => {
      if (event.type === 'turn_completed') {
        firstTurnContent = event.data.turn.content;
      }
    });
    
    // Agent calls initializeConversation with instructions
    await agent.initializeConversation('Be very brief');
    
    // Wait for turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify the message was modified based on instructions
    expect(firstTurnContent).toBe('Hi.');
    
    // Cleanup
    await agent.shutdown();
    await client.disconnect();
    await testEnv.stop();
  });
});