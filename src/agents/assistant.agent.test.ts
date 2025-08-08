import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AssistantAgent } from './assistant.agent';
import { MockLLMProvider } from '$src/llm/providers/mock';
import type { AgentContext } from './agent.types';

describe('AssistantAgent', () => {
  let mockProvider: MockLLMProvider;
  let agent: AssistantAgent;
  let mockContext: AgentContext;

  beforeEach(() => {
    mockProvider = new MockLLMProvider({ provider: 'mock' });
    agent = new AssistantAgent(mockProvider);
    
    mockContext = {
      conversationId: 1,
      agentId: 'assistant',
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
              payload: { text: 'Hello assistant' },
              finality: 'turn',
              ts: new Date().toISOString(),
              agentId: 'user',
              seq: 1
            }
          ]
        })),
        postMessage: mock(() => Promise.resolve({
          seq: 2,
          turn: 2,
          event: 1
        })),
        postTrace: mock(() => Promise.resolve({
          seq: 3,
          turn: 2,
          event: 2
        })),
        now: () => new Date()
      },
      logger: {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {})
      }
    };
  });

  it('creates agent with LLM provider', () => {
    expect(agent).toBeDefined();
  });

  it('processes turn and generates response', async () => {
    await agent.handleTurn(mockContext);
    
    // Verify it called getSnapshot
    expect(mockContext.client.getSnapshot).toHaveBeenCalledWith(1);
    
    // Verify it posted a message
    expect(mockContext.client.postMessage).toHaveBeenCalled();
    const postCall = (mockContext.client.postMessage as any).mock.calls[0][0];
    expect(postCall.conversationId).toBe(1);
    expect(postCall.agentId).toBe('assistant');
    expect(postCall.text).toContain('Mock response');
    expect(postCall.finality).toBe('turn');
  });

  it('includes system prompt in LLM messages', async () => {
    // Spy on provider's complete method
    const originalComplete = mockProvider.complete.bind(mockProvider);
    let capturedMessages: any[] = [];
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return originalComplete(request);
    });
    
    await agent.handleTurn(mockContext);
    
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0]).toEqual({
      role: 'system',
      content: 'You are a helpful assistant.'
    });
    expect(capturedMessages[1]).toEqual({
      role: 'user',
      content: 'Hello assistant'
    });
  });

  it('handles conversation with multiple messages', async () => {
    mockContext.client.getSnapshot = mock(() => Promise.resolve({
      conversation: 1,
      status: 'active' as const,
      events: [
        {
          type: 'message',
          payload: { text: 'User message 1' },
          agentId: 'user',
        },
        {
          type: 'message',
          payload: { text: 'Assistant response 1' },
          agentId: 'assistant',
        },
        {
          type: 'message',
          payload: { text: 'User message 2' },
          agentId: 'user',
        }
      ]
    }));
    
    const originalComplete = mockProvider.complete.bind(mockProvider);
    let capturedMessages: any[] = [];
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return originalComplete(request);
    });
    
    await agent.handleTurn(mockContext);
    
    expect(capturedMessages).toHaveLength(4);
    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[1]).toEqual({
      role: 'user',
      content: 'User message 1'
    });
    expect(capturedMessages[2]).toEqual({
      role: 'assistant',
      content: 'Assistant response 1'
    });
    expect(capturedMessages[3]).toEqual({
      role: 'user',
      content: 'User message 2'
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
          agentId: 'user',
        },
        {
          type: 'trace',
          payload: { type: 'thought', content: 'thinking...' },
          agentId: 'assistant',
        },
        {
          type: 'system',
          payload: { kind: 'note' },
          agentId: 'system',
        }
      ]
    }));
    
    const originalComplete = mockProvider.complete.bind(mockProvider);
    let capturedMessages: any[] = [];
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return originalComplete(request);
    });
    
    await agent.handleTurn(mockContext);
    
    // Should only have system prompt and user message
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[1].role).toBe('user');
  });

  it('logs start and completion of turn', async () => {
    await agent.handleTurn(mockContext);
    
    expect(mockContext.logger.info).toHaveBeenCalledTimes(2);
    const calls = (mockContext.logger.info as any).mock.calls;
    expect(calls[0][0]).toContain('AssistantAgent turn started');
    expect(calls[0][0]).toContain('mock'); // provider name
    expect(calls[1][0]).toContain('AssistantAgent turn completed');
  });

  it('works with different LLM providers', async () => {
    // Test that it can work with any provider implementing the interface
    const customProvider = {
      getMetadata: () => ({
        name: 'custom' as const,
        description: 'Custom provider',
        models: ['model-1'],
        defaultModel: 'model-1'
      }),
      complete: mock(async () => ({
        content: 'Custom response'
      }))
    };
    
    const customAgent = new AssistantAgent(customProvider as any);
    await customAgent.handleTurn(mockContext);
    
    expect(customProvider.complete).toHaveBeenCalled();
    expect(mockContext.client.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Custom response'
      })
    );
  });
});