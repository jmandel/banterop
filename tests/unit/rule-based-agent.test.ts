// Unit tests for RuleBasedAgent
import { test, expect, describe, beforeEach, vi } from 'bun:test';
import { RuleBasedAgent } from '../../src/agents/impl/rule-based.agent.js';
import type { 
  OrchestratorClient, 
  RuleBasedConfig, 
  TurnCompletedEvent, 
  ConversationTurn,
  TraceEntry,
  AgentId
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
    getConversation: vi.fn().mockResolvedValue({
      id: 'conv-123',
      turns: [],
      agents: []
    })
  } as unknown as OrchestratorClient;
  
  return mockClient;
};

describe('RuleBasedAgent', () => {
  let mockClient: OrchestratorClient;
  let agent: RuleBasedAgent;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  test('should respond when condition evaluates to true', async () => {
    const agentId: AgentId = { id: 'rule-agent', label: 'Rule Agent', role: 'test' };
    const config: RuleBasedConfig = {
      strategyType: 'rule_based',
      agentId,
      rules: [
        {
          condition: 'context.turn.content.includes("help")',
          actions: [
            { type: 'respond', payload: 'I can help you!' },
            { type: 'think', payload: 'User needs assistance' }
          ]
        }
      ]
    };

    agent = new RuleBasedAgent(config, mockClient);
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
          content: 'I need help with something',
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
    expect(mockClient.addTrace).toHaveBeenCalledWith('turn-123', {
      type: 'thought',
      content: 'Rule matched: context.turn.content.includes("help")'
    });
    expect(mockClient.addTrace).toHaveBeenCalledWith('turn-123', {
      type: 'thought', 
      content: 'User needs assistance'
    });
    expect(mockClient.completeTurn).toHaveBeenCalledWith('turn-123', 'I can help you!', undefined);
  });

  test('should not respond when condition evaluates to false', async () => {
    const agentId: AgentId = { id: 'rule-agent', label: 'Rule Agent', role: 'test' };
    const config: RuleBasedConfig = {
      strategyType: 'rule_based',
      agentId,
      rules: [
        {
          condition: 'context.turn.content.includes("urgent")',
          actions: [
            { type: 'respond', payload: 'This is urgent!' }
          ]
        }
      ]
    };

    agent = new RuleBasedAgent(config, mockClient);
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
          content: 'Hello there',
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
    const agentId: AgentId = { id: 'rule-agent', label: 'Rule Agent', role: 'test' };
    const config: RuleBasedConfig = {
      strategyType: 'rule_based',
      agentId,
      rules: [
        {
          condition: 'true', // Always match
          actions: [
            { type: 'respond', payload: 'Response' }
          ]
        }
      ]
    };

    agent = new RuleBasedAgent(config, mockClient);
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
          agentId: 'rule-agent', // Same as agent's ID
          timestamp: new Date(),
          content: 'Hello there',
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

  test('should execute only the first matching rule', async () => {
    const agentId: AgentId = { id: 'rule-agent', label: 'Rule Agent', role: 'test' };
    const config: RuleBasedConfig = {
      strategyType: 'rule_based',
      agentId,
      rules: [
        {
          condition: 'context.turn.content.includes("test")',
          actions: [
            { type: 'respond', payload: 'First rule matched!' }
          ]
        },
        {
          condition: 'context.turn.content.includes("test")', // Also matches
          actions: [
            { type: 'respond', payload: 'Second rule matched!' }
          ]
        }
      ]
    };

    agent = new RuleBasedAgent(config, mockClient);
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
          content: 'This is a test message',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date()
        },
        trace: []
      }
    };

    await agent.onTurnCompleted(turnCompletedEvent);

    // Verify only the first rule's response was used
    expect(mockClient.startTurn).toHaveBeenCalledTimes(1);
    expect(mockClient.completeTurn).toHaveBeenCalledWith('turn-123', 'First rule matched!', undefined);
  });

  test('should handle complex JavaScript conditions', async () => {
    const agentId: AgentId = { id: 'rule-agent', label: 'Rule Agent', role: 'test' };
    const config: RuleBasedConfig = {
      strategyType: 'rule_based',
      agentId,
      rules: [
        {
          condition: 'context.turn.content.length > 10 && context.turn.agentId !== "system"',
          actions: [
            { type: 'respond', payload: 'Complex condition matched!' }
          ]
        }
      ]
    };

    agent = new RuleBasedAgent(config, mockClient);
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
          agentId: 'user-agent',
          timestamp: new Date(),
          content: 'This is a long message with more than 10 characters',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date()
        },
        trace: []
      }
    };

    await agent.onTurnCompleted(turnCompletedEvent);

    // Verify the complex condition was evaluated correctly
    expect(mockClient.startTurn).toHaveBeenCalled();
    expect(mockClient.completeTurn).toHaveBeenCalledWith('turn-123', 'Complex condition matched!', undefined);
  });

  test('should handle malformed JavaScript conditions gracefully', async () => {
    const agentId: AgentId = { id: 'rule-agent', label: 'Rule Agent', role: 'test' };
    const config: RuleBasedConfig = {
      strategyType: 'rule_based',
      agentId,
      rules: [
        {
          condition: 'context.turn.content.includes("test") &&& invalid.syntax', // Invalid JS
          actions: [
            { type: 'respond', payload: 'Should not execute' }
          ]
        },
        {
          condition: 'context.turn.content.includes("test")', // Valid fallback
          actions: [
            { type: 'respond', payload: 'Fallback rule executed' }
          ]
        }
      ]
    };

    agent = new RuleBasedAgent(config, mockClient);

    // Mock console.error to verify error handling
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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
          content: 'This is a test message',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date()
        },
        trace: []
      }
    };

    await agent.onTurnCompleted(turnCompletedEvent);

    // Verify error was logged for the malformed condition
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error evaluating condition'),
      expect.any(Error)
    );

    // Verify the fallback rule was executed
    expect(mockClient.startTurn).toHaveBeenCalled();
    expect(mockClient.completeTurn).toHaveBeenCalledWith('turn-123', 'Fallback rule executed', undefined);

    consoleErrorSpy.mockRestore();
  });

  test('should execute multiple action types in sequence', async () => {
    const agentId: AgentId = { id: 'rule-agent', label: 'Rule Agent', role: 'test' };
    const config: RuleBasedConfig = {
      strategyType: 'rule_based',
      agentId,
      rules: [
        {
          condition: 'context.turn.content.includes("complex")',
          actions: [
            { type: 'think', payload: 'Analyzing the request' },
            { type: 'call_tool', payload: { tool: 'search', params: { query: 'complex' } } },
            { type: 'think', payload: 'Found the answer' },
            { type: 'respond', payload: 'Here is the complex answer' }
          ]
        }
      ]
    };

    agent = new RuleBasedAgent(config, mockClient);
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
          content: 'I have a complex question',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date()
        },
        trace: []
      }
    };

    await agent.onTurnCompleted(turnCompletedEvent);

    // Verify streaming pattern was used with all trace entries
    expect(mockClient.startTurn).toHaveBeenCalled();
    expect(mockClient.addTrace).toHaveBeenCalledWith('turn-123', {
      type: 'thought',
      content: 'Rule matched: context.turn.content.includes("complex")'
    });
    expect(mockClient.addTrace).toHaveBeenCalledWith('turn-123', {
      type: 'thought',
      content: 'Analyzing the request'
    });  
    expect(mockClient.addTrace).toHaveBeenCalledWith('turn-123', expect.objectContaining({
      type: 'tool_call',
      toolName: 'search',
      parameters: { query: 'complex' },
      toolCallId: expect.any(String)
    }));
    expect(mockClient.addTrace).toHaveBeenCalledWith('turn-123', expect.objectContaining({
      type: 'tool_result',
      toolCallId: expect.any(String),
      result: { status: 'completed' }
    }));
    expect(mockClient.addTrace).toHaveBeenCalledWith('turn-123', {
      type: 'thought',
      content: 'Found the answer'
    });
    expect(mockClient.completeTurn).toHaveBeenCalledWith('turn-123', 'Here is the complex answer', undefined);
  });

  test('should access conversation context through getConversation', async () => {
    const agentId: AgentId = { id: 'rule-agent', label: 'Rule Agent', role: 'test' };
    const config: RuleBasedConfig = {
      strategyType: 'rule_based',
      agentId,
      rules: [
        {
          condition: 'context.conversation && context.conversation.id === "conv-1"',
          actions: [
            { type: 'respond', payload: 'Conversation context accessed!' }
          ]
        }
      ]
    };

    agent = new RuleBasedAgent(config, mockClient);

    // Set up the mock to return specific conversation data
    (mockClient.getConversation as any).mockResolvedValue({
      id: 'conv-1',
      turns: [{ content: 'Previous turn' }],
      agents: []
    });

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
          content: 'Hello',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date()
        },
        trace: []
      }
    };

    await agent.onTurnCompleted(turnCompletedEvent);

    // Verify getConversation was called
    expect(mockClient.getConversation).toHaveBeenCalledWith(
      undefined, // conversationId should be undefined initially in test setup
      { includeTurns: true, includeTrace: true }
    );

    // Verify the rule executed based on conversation context
    expect(mockClient.startTurn).toHaveBeenCalled();
    expect(mockClient.completeTurn).toHaveBeenCalledWith('turn-123', 'Conversation context accessed!', undefined);
  });
});