import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AssistantAgent } from './assistant.agent';
import { MockLLMProvider } from '$src/llm/providers/mock';
import { MockTransport } from '$src/agents/runtime/mock.transport';
import { MockEvents } from '$src/agents/runtime/mock.events';
import type { GuidanceEvent, ConversationSnapshot } from '$src/types/orchestrator.types';
import type { UnifiedEvent } from '$src/types/event.types';

describe('AssistantAgent', () => {
  let mockProvider: MockLLMProvider;
  let mockTransport: MockTransport;
  let mockEvents: MockEvents;
  let agent: AssistantAgent;
  let eventHandlers: ((event: any) => void)[] = [];

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
    
    // Emit to all registered handlers
    eventHandlers.forEach(handler => handler(guidance));
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Helper to create events
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

  function createTraceEvent(agentId: string, content: any, seq: number = 2): UnifiedEvent {
    return {
      conversation: 1,
      turn: seq,
      event: 2,
      type: 'trace' as const,
      payload: { type: 'thought', content },
      agentId,
      finality: 'none' as const,
      ts: new Date().toISOString(),
      seq
    };
  }

  function createSystemEvent(seq: number = 3): UnifiedEvent {
    return {
      conversation: 1,
      turn: seq,
      event: 3,
      type: 'system' as const,
      payload: { kind: 'note' },
      agentId: 'system',
      finality: 'none' as const,
      ts: new Date().toISOString(),
      seq
    };
  }

  beforeEach(() => {
    mockProvider = new MockLLMProvider({ provider: 'mock' });
    mockTransport = new MockTransport();
    mockEvents = new MockEvents();
    eventHandlers = [];
    
    // Mock createEventStream to capture and use event handlers
    mockTransport.createEventStream.mockImplementation(() => {
      return {
        subscribe: (handler: (event: any) => void) => {
          eventHandlers.push(handler);
          return () => {
            const idx = eventHandlers.indexOf(handler);
            if (idx > -1) eventHandlers.splice(idx, 1);
          };
        }
      };
    });
    
    agent = new AssistantAgent(mockTransport, mockProvider);
    
    // Setup default mock responses
    mockTransport.getSnapshot.mockResolvedValue({
      conversation: 1,
      status: 'active' as const,
      metadata: { agents: [] },
      events: [
        createMessageEvent('user', 'Hello assistant')
      ],
      scenario: null,
      runtimeMeta: { agents: [] },
      lastClosedSeq: 0
    });
    
    mockTransport.abortTurn.mockResolvedValue({ turn: 2 });
  });

  it('creates agent with LLM provider', () => {
    expect(agent).toBeDefined();
  });

  it('processes turn and generates response', async () => {
    await triggerTurn(1, 'assistant');
    
    // Add a longer wait to ensure the async turn completes
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Verify it posted a message
    expect(mockTransport.postMessage).toHaveBeenCalled();
    const postCall = mockTransport.postMessage.mock.calls[0]?.[0];
    expect(postCall?.conversationId).toBe(1);
    expect(postCall?.agentId).toBe('assistant');
    expect(postCall?.text).toContain('Mock response');
    expect(postCall?.finality).toBe('turn');
  });

  it('includes system prompt in LLM messages', async () => {
    // Spy on provider's complete method
    const originalComplete = mockProvider.complete.bind(mockProvider);
    let capturedMessages: any[] = [];
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return originalComplete(request);
    });
    
    await triggerTurn(1, 'assistant');
    
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
    mockTransport.getSnapshot.mockResolvedValue({
      conversation: 1,
      status: 'active' as const,
      metadata: { agents: [] },
      events: [
        createMessageEvent('user', 'User message 1', 1),
        createMessageEvent('assistant', 'Assistant response 1', 2),
        createMessageEvent('user', 'User message 2', 3)
      ],
      scenario: null,
      runtimeMeta: { agents: [] },
      lastClosedSeq: 0
    });
    
    const originalComplete = mockProvider.complete.bind(mockProvider);
    let capturedMessages: any[] = [];
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return originalComplete(request);
    });
    
    await triggerTurn(1, 'assistant', 3.1);
    
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
    mockTransport.getSnapshot.mockResolvedValue({
      conversation: 1,
      status: 'active' as const,
      metadata: { agents: [] },
      events: [
        createMessageEvent('user', 'User message'),
        createTraceEvent('assistant', 'thinking...'),
        createSystemEvent()
      ],
      scenario: null,
      runtimeMeta: { agents: [] },
      lastClosedSeq: 0
    });
    
    const originalComplete = mockProvider.complete.bind(mockProvider);
    let capturedMessages: any[] = [];
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return originalComplete(request);
    });
    
    await triggerTurn(1, 'assistant');
    
    // Should only have system prompt and user message
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[1]).toEqual({
      role: 'user',
      content: 'User message'
    });
  });

  it('handles empty conversation history', async () => {
    mockTransport.getSnapshot.mockResolvedValue({
      conversation: 1,
      status: 'active' as const,
      metadata: { agents: [] },
      events: [],
      scenario: null,
      runtimeMeta: { agents: [] },
      lastClosedSeq: 0
    });
    
    await triggerTurn(1, 'assistant');
    
    // Add a longer wait to ensure the async turn completes
    await new Promise(resolve => setTimeout(resolve, 200));
    
    expect(mockTransport.postMessage).toHaveBeenCalled();
  });

  it('correctly identifies own messages vs other agents', async () => {
    mockTransport.getSnapshot.mockResolvedValue({
      conversation: 1,
      status: 'active' as const,
      metadata: { agents: [] },
      events: [
        createMessageEvent('user', 'First user message', 1),
        createMessageEvent('assistant', 'My response', 2),
        createMessageEvent('other-agent', 'Other agent message', 3),
        createMessageEvent('assistant', 'Another of my responses', 4)
      ],
      scenario: null,
      runtimeMeta: { agents: [] },
      lastClosedSeq: 0
    });
    
    const originalComplete = mockProvider.complete.bind(mockProvider);
    let capturedMessages: any[] = [];
    mockProvider.complete = mock(async (request) => {
      capturedMessages = request.messages;
      return originalComplete(request);
    });
    
    await triggerTurn(1, 'assistant');
    
    expect(capturedMessages).toHaveLength(5);
    expect(capturedMessages[1].role).toBe('user'); // First user message
    expect(capturedMessages[2].role).toBe('assistant'); // My response  
    expect(capturedMessages[3].role).toBe('user'); // Other agent treated as user
    expect(capturedMessages[4].role).toBe('assistant'); // Another of my responses
  });

  it('handles provider errors gracefully', async () => {
    const errorMessage = 'Provider error';
    mockProvider.complete = mock(() => Promise.reject(new Error(errorMessage)));
    
    // Should not throw - errors are caught in BaseAgent
    await expect(triggerTurn(1, 'assistant')).resolves.toBeUndefined();
  });

  it('posts message with correct structure', async () => {
    await triggerTurn(1, 'assistant');
    
    // Add a longer wait to ensure the async turn completes
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Allow additional fields (e.g., precondition) while asserting required shape
    expect(mockTransport.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 1,
      agentId: 'assistant',
      text: expect.stringContaining('Mock response'),
      finality: 'turn'
    }));
  });
});
