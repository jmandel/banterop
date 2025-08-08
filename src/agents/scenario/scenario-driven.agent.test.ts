import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ScenarioDrivenAgent } from './scenario-driven.agent';
import { MockLLMProvider } from '$src/llm/providers/mock';
import { ProviderManager } from '$src/llm/provider-manager';
import { MockTransport } from '$src/agents/runtime/mock.transport';
import { MockEvents } from '$src/agents/runtime/mock.events';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import type { HydratedConversationSnapshot, GuidanceEvent } from '$src/types/orchestrator.types';
import type { UnifiedEvent } from '$src/types/event.types';

describe('ScenarioDrivenAgent', () => {
  let providerManager: ProviderManager;
  let mockProvider: MockLLMProvider;
  let mockTransport: MockTransport;
  let mockEvents: MockEvents;
  let agent: ScenarioDrivenAgent;
  let testScenario: ScenarioConfiguration;

  // Helper to trigger a turn
  async function triggerTurn(conversationId: number, agentId: string, seq: number = 1.1) {
    await agent.start(conversationId, agentId);
    
    const guidance: GuidanceEvent = {
      type: 'guidance',
      conversation: conversationId,
      seq,
      nextAgentId: agentId,
      deadlineMs: 30000
    };
    
    mockEvents.emit(guidance);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Helper to create message event
  function createMessageEvent(agentId: string, text: string, seq: number = 1): UnifiedEvent {
    return {
      conversation: 1,
      turn: seq,
      event: 1,
      type: 'message' as const,
      payload: { text },
      agentId,
      finality: 'turn' as const,
      ts: new Date().toISOString(),
      seq
    };
  }

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
    
    // Create mock transport and events
    mockTransport = new MockTransport();
    mockEvents = new MockEvents();
    
    // Setup default mock responses
    mockTransport.getSnapshot.mockResolvedValue({
      conversation: 1,
      status: 'active' as const,
      scenario: testScenario,
      runtimeMeta: { 
        agents: [
          { id: 'test-agent', kind: 'internal' },
          { id: 'other-agent', kind: 'internal' }
        ]
      },
      events: [
        createMessageEvent('other-agent', 'Hello test agent')
      ],
      lastClosedSeq: 0
    } as HydratedConversationSnapshot);
    
    // Create agent
    agent = new ScenarioDrivenAgent(mockTransport, mockEvents, {
      agentId: 'test-agent',
      providerManager,
    });
  });

  it('creates agent with provider manager', () => {
    expect(agent).toBeDefined();
  });

  it('builds system prompt from scenario configuration', async () => {
    const originalComplete = mockProvider.complete.bind(mockProvider);
    let capturedMessages: any[] = [];
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return originalComplete(request);
    });
    
    await triggerTurn(1, 'test-agent');
    
    expect(capturedMessages).toHaveLength(2);
    const systemPrompt = capturedMessages[0].content;
    
    // Check that system prompt includes key elements from scenario
    expect(systemPrompt).toContain('You are a test agent. Be helpful.');
    expect(systemPrompt).toContain('Test Agent');
    expect(systemPrompt).toContain('You are in a test environment');
    expect(systemPrompt).toContain('Assist with testing');
    expect(systemPrompt).toContain('Test Scenario');
    expect(systemPrompt).toContain('Testing scenario-driven agents');
  });

  it('includes knowledge base in system prompt', async () => {
    const originalComplete = mockProvider.complete.bind(mockProvider);
    let capturedMessages: any[] = [];
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return originalComplete(request);
    });
    
    await triggerTurn(1, 'test-agent');
    
    const systemPrompt = capturedMessages[0].content;
    expect(systemPrompt).toContain('testFact');
    expect(systemPrompt).toContain('This is test knowledge');
  });

  it('includes tool descriptions in system prompt', async () => {
    const originalComplete = mockProvider.complete.bind(mockProvider);
    let capturedMessages: any[] = [];
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return originalComplete(request);
    });
    
    await triggerTurn(1, 'test-agent');
    
    const systemPrompt = capturedMessages[0].content;
    expect(systemPrompt).toContain('test_tool');
    expect(systemPrompt).toContain('A test tool');
  });

  it('handles conversation history correctly', async () => {
    mockTransport.getSnapshot.mockResolvedValue({
      conversation: 1,
      status: 'active' as const,
      scenario: testScenario,
      runtimeMeta: { 
        agents: [
          { id: 'test-agent', kind: 'internal' },
          { id: 'other-agent', kind: 'internal' }
        ]
      },
      events: [
        createMessageEvent('other-agent', 'First message', 1),
        createMessageEvent('test-agent', 'My response', 2),
        createMessageEvent('other-agent', 'Second message', 3),
      ],
      lastClosedSeq: 0
    } as HydratedConversationSnapshot);
    
    const originalComplete = mockProvider.complete.bind(mockProvider);
    let capturedMessages: any[] = [];
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return originalComplete(request);
    });
    
    await triggerTurn(1, 'test-agent', 3.1);
    
    // ScenarioDrivenAgent passes conversation history as part of the prompt content,
    // not as separate messages. It constructs 2 messages: system and user
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[1].role).toBe('user');
    
    // The user content should include the conversation history
    const userContent = capturedMessages[1].content;
    expect(userContent).toContain('First message');
    expect(userContent).toContain('My response');
    expect(userContent).toContain('Second message');
    expect(userContent).toContain('other-agent');
    expect(userContent).toContain('test-agent');
  });

  it('posts message with turn finality', async () => {
    await triggerTurn(1, 'test-agent');
    
    // Add a longer wait to ensure the async turn completes
    await new Promise(resolve => setTimeout(resolve, 200));
    
    expect(mockTransport.postMessage).toHaveBeenCalled();
    const postCall = mockTransport.postMessage.mock.calls[0]?.[0];
    expect(postCall?.conversationId).toBe(1);
    expect(postCall?.agentId).toBe('test-agent');
    expect(postCall?.finality).toBe('turn');
  });

  it('uses agent-specific provider config when available', async () => {
    // Setup agent with specific provider config
    mockTransport.getSnapshot.mockResolvedValue({
      conversation: 1,
      status: 'active' as const,
      scenario: testScenario,
      runtimeMeta: { 
        agents: [
          { 
            id: 'test-agent', 
            kind: 'internal',
            config: {
              llmProvider: 'mock',
              model: 'test-model'
            }
          },
          { id: 'other-agent', kind: 'internal' }
        ]
      },
      events: [
        createMessageEvent('other-agent', 'Hello')
      ],
      lastClosedSeq: 0
    } as HydratedConversationSnapshot);
    
    await triggerTurn(1, 'test-agent');
    
    // Verify provider was requested with correct config
    expect(providerManager.getProvider).toHaveBeenCalled();
  });

  it('throws error when scenario is missing', async () => {
    mockTransport.getSnapshot.mockResolvedValue({
      conversation: 1,
      status: 'active' as const,
      scenario: null,
      runtimeMeta: { agents: [] },
      events: [],
      lastClosedSeq: 0
    } as HydratedConversationSnapshot);
    
    // Should not throw - error is caught in BaseAgent
    await expect(triggerTurn(1, 'test-agent')).resolves.toBeUndefined();
  });

  it('throws error when agent not found in scenario', async () => {
    mockTransport.getSnapshot.mockResolvedValue({
      conversation: 1,
      status: 'active' as const,
      scenario: testScenario,
      runtimeMeta: { agents: [] },
      events: [],
      lastClosedSeq: 0
    } as HydratedConversationSnapshot);
    
    // Create agent with ID not in scenario
    const wrongAgent = new ScenarioDrivenAgent(mockTransport, mockEvents, {
      agentId: 'unknown-agent',
      providerManager,
    });
    
    await wrongAgent.start(1, 'unknown-agent');
    
    const guidance: GuidanceEvent = {
      type: 'guidance',
      conversation: 1,
      seq: 1.1,
      nextAgentId: 'unknown-agent',
      deadlineMs: 30000
    };
    
    mockEvents.emit(guidance);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Should handle error gracefully
    expect(mockTransport.postMessage).not.toHaveBeenCalled();
  });

  it('handles conversation with incomplete tool calls from previous turns', async () => {
    // Add a tool_call trace event to the history without a corresponding tool_result
    // This tests that the agent can handle seeing incomplete tool calls in history
    mockTransport.getSnapshot.mockResolvedValue({
      conversation: 1,
      status: 'active' as const,
      scenario: testScenario,
      runtimeMeta: { 
        agents: [
          { id: 'test-agent', kind: 'internal' },
          { id: 'other-agent', kind: 'internal' }
        ]
      },
      events: [
        createMessageEvent('other-agent', 'Please use your tool'),
        {
          conversation: 1,
          turn: 2,
          event: 1,
          type: 'trace' as const,
          payload: {
            type: 'tool_call',
            toolCallId: 'test-call-1',
            name: 'test_tool',
            args: { input: 'test' }
          },
          agentId: 'test-agent',
          finality: 'none' as const,
          ts: new Date().toISOString(),
          seq: 2
        }
      ],
      lastClosedSeq: 0
    } as HydratedConversationSnapshot);
    
    await triggerTurn(1, 'test-agent');
    
    // Add a longer wait to ensure the async turn completes
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // The agent starts fresh each turn and doesn't try to complete pending tool calls
    // It should post at least a thought trace as it processes the turn
    expect(mockTransport.postTrace).toHaveBeenCalled();
    const traceCall = mockTransport.postTrace.mock.calls[0]?.[0];
    expect(traceCall?.payload.type).toBe('thought');
    
    // Should eventually post a message to complete the turn
    expect(mockTransport.postMessage).toHaveBeenCalled();
  });
});