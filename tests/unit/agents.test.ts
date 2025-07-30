// Unit tests for Agent implementations
import { test, expect, describe, beforeEach, vi } from 'bun:test';
import { StaticReplayAgent } from '../../src/agents/static-replay.agent.js';
import type { 
  OrchestratorClient, 
  StaticReplayConfig, 
  TurnCompletedEvent, 
  ConversationTurn,
  TraceEntry
} from '../../src/lib/types.js';

// Mock the OrchestratorClient
const createMockClient = (): OrchestratorClient => {
  const mockClient = {
    // EventEmitter methods
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    removeAllListeners: vi.fn(),
    
    // Connection management
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    
    // Authentication
    authenticate: vi.fn().mockResolvedValue({}),
    
    // Subscription management
    subscribe: vi.fn().mockResolvedValue('sub-123'),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribeAll: vi.fn().mockResolvedValue(undefined),
    
    // Turn management
    startTurn: vi.fn().mockResolvedValue('turn-123'),
    addTrace: vi.fn().mockResolvedValue(undefined),
    completeTurn: vi.fn().mockResolvedValue({} as ConversationTurn),
    
    
    // User interaction
    createUserQuery: vi.fn().mockResolvedValue('query-123'),
    respondToUserQuery: vi.fn().mockResolvedValue(undefined),
    
    // Conversation access
    getConversation: vi.fn().mockResolvedValue({})
  } as unknown as OrchestratorClient;
  
  return mockClient;
};

describe('StaticReplayAgent', () => {
  let mockClient: OrchestratorClient;
  let agent: StaticReplayAgent;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  test('should respond when a trigger matches', async () => {
    const config: StaticReplayConfig = {
      strategyType: 'static_replay',
      agentId: { id: 'agent-1', label: 'Test Agent', role: 'test' },
      script: [
        {
          trigger: 'hello',
          response: 'Hi there!',
          thoughts: ['I should greet back']
        }
      ]
    };

    agent = new StaticReplayAgent(config, mockClient);
    // Set the conversation ID that would normally be set during initialization
    (agent as any).conversationId = 'conv-1';

    const turnCompletedEvent: TurnCompletedEvent = {
      type: 'turn_completed',
      conversationId: 'conv-1',
      timestamp: new Date(),
      data: {
        turn: {
          id: 'turn-1',
          conversationId: 'conv-1',
          agentId: 'other-agent',
          timestamp: new Date(),
          content: 'hello there',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date()
        },
        trace: []
      }
    };

    await agent.onTurnCompleted(turnCompletedEvent);

    // Verify the new streaming pattern was used
    expect(mockClient.startTurn).toHaveBeenCalled();
    expect(mockClient.addTrace).toHaveBeenCalledWith(
      'turn-123',
      expect.objectContaining({
        type: 'thought',
        content: 'I should greet back'
      })
    );
    expect(mockClient.completeTurn).toHaveBeenCalledWith('turn-123', 'Hi there!', undefined);
  });

  test('should not respond if trigger does not match', async () => {
    const config: StaticReplayConfig = {
      strategyType: 'static_replay',
      agentId: { id: 'agent-1', label: 'Test Agent', role: 'test' },
      script: [
        {
          trigger: 'goodbye',
          response: 'See you later!'
        }
      ]
    };

    agent = new StaticReplayAgent(config, mockClient);
    // Set the conversation ID that would normally be set during initialization
    (agent as any).conversationId = 'conv-1';

    const turnCompletedEvent: TurnCompletedEvent = {
      type: 'turn_completed',
      conversationId: 'conv-1',
      timestamp: new Date(),
      data: {
        turn: {
          id: 'turn-1',
          conversationId: 'conv-1',
          agentId: 'other-agent',
          timestamp: new Date(),
          content: 'hello there',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date()
        },
        trace: []
      }
    };

    await agent.onTurnCompleted(turnCompletedEvent);

    // Verify no turn was started (new pattern)
    expect(mockClient.startTurn).not.toHaveBeenCalled();
  });

  test('should not respond to its own turns', async () => {
    const config: StaticReplayConfig = {
      strategyType: 'static_replay',
      agentId: { id: 'agent-1', label: 'Test Agent', role: 'test' },
      script: [
        {
          trigger: 'hello',
          response: 'Hi there!'
        }
      ]
    };

    agent = new StaticReplayAgent(config, mockClient);
    // Set the conversation ID that would normally be set during initialization
    (agent as any).conversationId = 'conv-1';

    const turnCompletedEvent: TurnCompletedEvent = {
      type: 'turn_completed',
      conversationId: 'conv-1',
      timestamp: new Date(),
      data: {
        turn: {
          id: 'turn-1',
          conversationId: 'conv-1',
          agentId: 'agent-1', // Same as agent's ID
          timestamp: new Date(),
          content: 'hello there',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date()
        },
        trace: []
      }
    };

    await agent.onTurnCompleted(turnCompletedEvent);

    // Verify no turn was started (new pattern)
    expect(mockClient.startTurn).not.toHaveBeenCalled();
  });

  test('should not respond if no trigger is specified', async () => {
    const config: StaticReplayConfig = {
      strategyType: 'static_replay',
      agentId: { id: 'agent-1', label: 'Test Agent', role: 'test' },
      script: [
        {
          // No trigger specified
          response: 'Automatic response'
        }
      ]
    };

    agent = new StaticReplayAgent(config, mockClient);
    // Set the conversation ID that would normally be set during initialization
    (agent as any).conversationId = 'conv-1';

    const turnCompletedEvent: TurnCompletedEvent = {
      type: 'turn_completed',
      conversationId: 'conv-1',
      timestamp: new Date(),
      data: {
        turn: {
          id: 'turn-1',
          conversationId: 'conv-1',
          agentId: 'other-agent',
          timestamp: new Date(),
          content: 'any message',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date()
        },
        trace: []
      }
    };

    await agent.onTurnCompleted(turnCompletedEvent);

    // Verify no turn was started (new pattern)
    expect(mockClient.startTurn).not.toHaveBeenCalled();
  });

  test('should use regex patterns in triggers', async () => {
    const config: StaticReplayConfig = {
      strategyType: 'static_replay',
      agentId: { id: 'agent-1', label: 'Test Agent', role: 'test' },
      script: [
        {
          trigger: 'help.*urgent',
          response: 'I will help you immediately!'
        }
      ]
    };

    agent = new StaticReplayAgent(config, mockClient);
    // Set the conversation ID that would normally be set during initialization
    (agent as any).conversationId = 'conv-1';

    const turnCompletedEvent: TurnCompletedEvent = {
      type: 'turn_completed',
      conversationId: 'conv-1',
      timestamp: new Date(),
      data: {
        turn: {
          id: 'turn-1',
          conversationId: 'conv-1',
          agentId: 'other-agent',
          timestamp: new Date(),
          content: 'help me this is urgent',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date()
        },
        trace: []
      }
    };

    await agent.onTurnCompleted(turnCompletedEvent);

    // Verify the new streaming pattern was used
    expect(mockClient.startTurn).toHaveBeenCalled();
    expect(mockClient.completeTurn).toHaveBeenCalledWith('turn-123', 'I will help you immediately!', undefined);
  });

  test('should only respond once per turn even with multiple matching triggers', async () => {
    const config: StaticReplayConfig = {
      strategyType: 'static_replay',
      agentId: { id: 'agent-1', label: 'Test Agent', role: 'test' },
      script: [
        {
          trigger: 'hello',
          response: 'First response'
        },
        {
          trigger: 'hello',
          response: 'Second response'
        }
      ]
    };

    agent = new StaticReplayAgent(config, mockClient);
    // Set the conversation ID that would normally be set during initialization
    (agent as any).conversationId = 'conv-1';

    const turnCompletedEvent: TurnCompletedEvent = {
      type: 'turn_completed',
      conversationId: 'conv-1',
      timestamp: new Date(),
      data: {
        turn: {
          id: 'turn-1',
          conversationId: 'conv-1',
          agentId: 'other-agent',
          timestamp: new Date(),
          content: 'hello there',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date()
        },
        trace: []
      }
    };

    await agent.onTurnCompleted(turnCompletedEvent);

    // Verify streaming pattern was called only once with the first matching response
    expect(mockClient.startTurn).toHaveBeenCalledTimes(1);
    expect(mockClient.completeTurn).toHaveBeenCalledWith('turn-123', 'First response', undefined);
  });

  test('should handle multiple thoughts in trace', async () => {
    const config: StaticReplayConfig = {
      strategyType: 'static_replay',
      agentId: { id: 'agent-1', label: 'Test Agent', role: 'test' },
      script: [
        {
          trigger: 'complex',
          response: 'Analyzed!',
          thoughts: [
            'This is a complex question',
            'Let me think about it',
            'I have the answer'
          ]
        }
      ]
    };

    agent = new StaticReplayAgent(config, mockClient);
    // Set the conversation ID that would normally be set during initialization
    (agent as any).conversationId = 'conv-1';

    const turnCompletedEvent: TurnCompletedEvent = {
      type: 'turn_completed',
      conversationId: 'conv-1',
      timestamp: new Date(),
      data: {
        turn: {
          id: 'turn-1',
          conversationId: 'conv-1',
          agentId: 'other-agent',
          timestamp: new Date(),
          content: 'complex problem',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date()
        },
        trace: []
      }
    };

    await agent.onTurnCompleted(turnCompletedEvent);

    // Verify all three thoughts were added as trace entries
    expect(mockClient.startTurn).toHaveBeenCalled();
    expect(mockClient.addTrace).toHaveBeenCalledTimes(3);
    expect(mockClient.addTrace).toHaveBeenCalledWith('turn-123', expect.objectContaining({
      type: 'thought',
      content: 'This is a complex question'
    }));
    expect(mockClient.addTrace).toHaveBeenCalledWith('turn-123', expect.objectContaining({
      type: 'thought',
      content: 'Let me think about it'
    }));
    expect(mockClient.addTrace).toHaveBeenCalledWith('turn-123', expect.objectContaining({
      type: 'thought',
      content: 'I have the answer'
    }));
    expect(mockClient.completeTurn).toHaveBeenCalledWith('turn-123', 'Analyzed!', undefined);
  });
});