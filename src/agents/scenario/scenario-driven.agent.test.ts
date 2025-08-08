import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ScenarioDrivenAgent } from './scenario-driven.agent';
import { MockLLMProvider } from '$src/llm/providers/mock';
import { ProviderManager } from '$src/llm/provider-manager';
import type { AgentContext } from '$src/agents/agent.types';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import type { HydratedConversationSnapshot } from '$src/types/orchestrator.types';

describe('ScenarioDrivenAgent', () => {
  let providerManager: ProviderManager;
  let mockProvider: MockLLMProvider;
  let agent: ScenarioDrivenAgent;
  let mockContext: AgentContext;
  let testScenario: ScenarioConfiguration;

  beforeEach(() => {
    // Create mock provider
    mockProvider = new MockLLMProvider({ provider: 'mock' });
    
    // Create provider manager that returns our mock
    const config = {
      defaultLlmProvider: 'mock' as const,
      googleApiKey: '',
      openRouterApiKey: '',
    };
    providerManager = new ProviderManager(config as any);
    
    // Mock getProvider to always return the same instance
    providerManager.getProvider = mock(() => mockProvider);
    
    // Create test scenario
    testScenario = {
      metadata: {
        id: 'test-scenario',
        title: 'Test Scenario',
        description: 'A test scenario',
        tags: ['test'],
      },
      scenario: {
        background: 'Testing scenario-driven agents',
        challenges: ['Test challenge'],
      },
      agents: [
        {
          agentId: 'test-agent',
          principal: {
            type: 'individual',
            name: 'Test Agent',
            description: 'A helpful test agent',
          },
          situation: 'You are in a test environment',
          systemPrompt: 'You are a test agent. Be helpful.',
          goals: ['Assist with testing', 'Provide good responses'],
          tools: [
            {
              toolName: 'test_tool',
              description: 'A test tool',
              inputSchema: { type: 'object' },
              synthesisGuidance: 'Return test data',
            },
          ],
          knowledgeBase: {
            testFact: 'This is test knowledge',
          },
        },
        {
          agentId: 'other-agent',
          principal: {
            type: 'individual',
            name: 'Other Agent',
            description: 'Another agent',
          },
          situation: 'You are the other party',
          systemPrompt: 'You are the other agent.',
          goals: ['Interact with test agent'],
          tools: [],
          knowledgeBase: {},
        },
      ],
    };
    
    // Create agent
    agent = new ScenarioDrivenAgent({
      agentId: 'test-agent',
      providerManager,
    });
    
    // Create mock context
    mockContext = {
      conversationId: 1,
      agentId: 'test-agent',
      deadlineMs: Date.now() + 30000,
      client: {
        getSnapshot: mock(() => Promise.resolve({
          conversation: 1,
          status: 'active' as const,
          events: [
            {
              conversation: 1,
              turn: 1,
              event: 1,
              type: 'message',
              payload: { text: 'Hello agent' },
              finality: 'turn',
              ts: new Date().toISOString(),
              agentId: 'other-agent',
              seq: 1,
            },
          ],
          scenario: testScenario,
          runtimeMeta: {
            agents: [
              { id: 'test-agent', kind: 'internal' as const },
              { id: 'other-agent', kind: 'external' as const },
            ],
          },
        } as HydratedConversationSnapshot)),
        postMessage: mock(() => Promise.resolve({
          seq: 2,
          turn: 2,
          event: 1,
        })),
        postTrace: mock(() => Promise.resolve({
          seq: 3,
          turn: 2,
          event: 2,
        })),
        now: () => new Date(),
      },
      logger: {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      },
    };
  });

  it('creates agent with provider manager', () => {
    expect(agent).toBeDefined();
  });

  it('handles turn and generates response', async () => {
    await agent.handleTurn(mockContext);
    
    // Verify it called getSnapshot
    expect(mockContext.client.getSnapshot).toHaveBeenCalledWith(1);
    
    // Verify it posted a message
    expect(mockContext.client.postMessage).toHaveBeenCalled();
    const postCall = (mockContext.client.postMessage as any).mock.calls[0][0];
    expect(postCall.conversationId).toBe(1);
    expect(postCall.agentId).toBe('test-agent');
    expect(postCall.text).toContain('Mock response');
    expect(postCall.finality).toBe('turn');
  });

  it('includes scenario context in system prompt', async () => {
    // Spy on provider to capture messages
    let capturedMessages: any[] = [];
    const originalComplete = mockProvider.complete.bind(mockProvider);
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return originalComplete(request);
    });
    
    await agent.handleTurn(mockContext);
    
    expect(capturedMessages).toHaveLength(2);
    const systemMessage = capturedMessages[0];
    expect(systemMessage.role).toBe('system');
    expect(systemMessage.content).toContain('You are a test agent. Be helpful.');
    expect(systemMessage.content).toContain('Test Agent');
    expect(systemMessage.content).toContain('You are in a test environment');
    expect(systemMessage.content).toContain('Assist with testing');
    expect(systemMessage.content).toContain('Test Scenario');
    expect(systemMessage.content).toContain('testFact');
    expect(systemMessage.content).toContain('test_tool');
  });

  it('uses agent-specific LLM provider config', async () => {
    // Create a custom mock provider
    const customProvider = new MockLLMProvider({ provider: 'mock' });
    customProvider.complete = mock(async () => ({ content: 'Custom provider response' }));
    
    // Mock getProvider to return custom provider when requested
    providerManager.getProvider = mock((config?: any) => {
      if (config?.provider === 'custom') {
        return customProvider;
      }
      return mockProvider;
    });
    
    // Update context with agent-specific config
    mockContext.client.getSnapshot = mock(() => Promise.resolve({
      conversation: 1,
      status: 'active' as const,
      events: [],
      scenario: testScenario,
      runtimeMeta: {
        agents: [
          { 
            id: 'test-agent', 
            kind: 'internal' as const,
            config: {
              llmProvider: 'custom',
              model: 'custom-model',
            },
          },
        ],
      },
    } as HydratedConversationSnapshot));
    
    await agent.handleTurn(mockContext);
    
    // Verify custom provider was called
    expect(customProvider.complete).toHaveBeenCalled();
    expect(mockContext.client.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Custom provider response',
      })
    );
  });

  it('handles missing scenario gracefully', async () => {
    mockContext.client.getSnapshot = mock(() => Promise.resolve({
      conversation: 1,
      status: 'active' as const,
      events: [],
      // No scenario
    }));
    
    await expect(agent.handleTurn(mockContext)).rejects.toThrow(
      'Conversation 1 lacks scenario configuration'
    );
  });

  it('handles missing agent in scenario', async () => {
    mockContext.agentId = 'unknown-agent';
    
    await expect(agent.handleTurn(mockContext)).rejects.toThrow(
      'Agent unknown-agent not found in scenario configuration'
    );
  });

  it('builds conversation history correctly', async () => {
    mockContext.client.getSnapshot = mock(() => Promise.resolve({
      conversation: 1,
      status: 'active' as const,
      events: [
        {
          type: 'message',
          payload: { text: 'User message 1' },
          agentId: 'other-agent',
        },
        {
          type: 'message',
          payload: { text: 'Agent response 1' },
          agentId: 'test-agent',
        },
        {
          type: 'message',
          payload: { text: 'User message 2' },
          agentId: 'other-agent',
        },
      ],
      scenario: testScenario,
      runtimeMeta: {
        agents: [
          { id: 'test-agent', kind: 'internal' as const },
          { id: 'other-agent', kind: 'external' as const },
        ],
      },
    } as HydratedConversationSnapshot));
    
    let capturedMessages: any[] = [];
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return { content: 'Response' };
    });
    
    await agent.handleTurn(mockContext);
    
    expect(capturedMessages).toHaveLength(4);
    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[1]).toEqual({
      role: 'user',
      content: 'User message 1',
    });
    expect(capturedMessages[2]).toEqual({
      role: 'assistant',
      content: 'Agent response 1',
    });
    expect(capturedMessages[3]).toEqual({
      role: 'user',
      content: 'User message 2',
    });
  });

  it('filters out non-message events', async () => {
    mockContext.client.getSnapshot = mock(() => Promise.resolve({
      conversation: 1,
      status: 'active' as const,
      events: [
        {
          type: 'message',
          payload: { text: 'User message' },
          agentId: 'other-agent',
        },
        {
          type: 'trace',
          payload: { type: 'thought', content: 'thinking...' },
          agentId: 'test-agent',
        },
        {
          type: 'system',
          payload: { kind: 'note' },
          agentId: 'system',
        },
      ],
      scenario: testScenario,
      runtimeMeta: {
        agents: [{ id: 'test-agent', kind: 'internal' as const }],
      },
    } as HydratedConversationSnapshot));
    
    let capturedMessages: any[] = [];
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return { content: 'Response' };
    });
    
    await agent.handleTurn(mockContext);
    
    // Should only have system prompt and user message
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[1].role).toBe('user');
  });
});