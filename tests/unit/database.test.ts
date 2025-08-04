// Unit tests for ConversationDatabase
import { test, expect, describe, beforeEach } from 'bun:test';
import { ConversationDatabase } from '../../src/backend/db/database.js';
import type { 
  Conversation, 
  ConversationTurn, 
  TraceEntry,
  ThoughtEntry,
  StaticReplayConfig
} from '../../src/lib/types.js';

describe('ConversationDatabase', () => {
  let db: ConversationDatabase;

  beforeEach(() => {
    // Uses a new in-memory database for each test
    db = new ConversationDatabase(':memory:');
  });

  test('should create and retrieve a conversation', () => {
    const conversation: Conversation = {
      id: 'test-conv-1',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      agents: [{ id: 'agent-1', strategyType: 'static_replay', script: [] } as StaticReplayConfig],
      turns: [],
      status: 'active',
      metadata: { conversationTitle: "Test Conversation" }
    };

    db.createConversation(conversation);
    const retrieved = db.getConversation('test-conv-1', false);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('test-conv-1');
    expect(conversation.metadata.conversationTitle).toBe('Test Conversation');
    expect(retrieved!.status).toBe('active');
    expect(retrieved!.agents).toHaveLength(1);
    expect(retrieved!.agents[0].id).toBe('agent-1');
    
  });

  test('should add and retrieve turns for a conversation', () => {
    // First create a conversation
    const conversation: Conversation = {
      id: 'test-conv-2',
      createdAt: new Date(),
      agents: [{ id: 'agent-1', strategyType: 'static_replay', script: [] } as StaticReplayConfig],
      turns: [],
      status: 'active',
      metadata: { conversationTitle: 'Test Conversation 2' }
    };
    db.createConversation(conversation);
      
    const turn: ConversationTurn = {
      id: 'turn-1',
      conversationId: 'test-conv-2',
      agentId: 'agent-1',
      timestamp: new Date('2024-01-01T01:00:00Z'),
      content: 'Hello, this is a test turn',
      status: 'completed',
      startedAt: new Date('2024-01-01T01:00:00Z'),
      completedAt: new Date('2024-01-01T01:00:05Z'),
      metadata: { turnType: 'greeting' }
    };
    db.addTurn(turn);
      
    const turns = db.getTurns('test-conv-2');
    expect(turns).toHaveLength(1);
    expect(turns[0].id).toBe('turn-1');
    expect(turns[0].content).toBe('Hello, this is a test turn');
    expect(turns[0].agentId).toBe('agent-1');
    expect(turns[0].status).toBe('completed');
    expect(turns[0].metadata?.turnType).toBe('greeting');
  });

  test('should handle streaming turns (start, complete)', () => {
    // Create conversation
    const conversation: Conversation = {
      id: 'test-conv-3',
      createdAt: new Date(),
      agents: [{ id: 'agent-1', strategyType: 'static_replay', script: [] } as StaticReplayConfig],
      turns: [],
      status: 'active',
      metadata: { conversationTitle: 'Streaming Test' }
    };
    db.createConversation(conversation);
      
    db.startTurn('turn-stream-1', 'test-conv-3', 'agent-1', { test: true });
      
    const inProgressTurns = db.getInProgressTurns('test-conv-3');
    expect(inProgressTurns).toHaveLength(1);
    expect(inProgressTurns[0].id).toBe('turn-stream-1');
    expect(inProgressTurns[0].status).toBe('in_progress');
    expect(inProgressTurns[0].content).toBe('');
      
    db.completeTurn('turn-stream-1', 'This is the completed content');
      
    const completedTurns = db.getTurns('test-conv-3');
    expect(completedTurns).toHaveLength(1);
    expect(completedTurns[0].status).toBe('completed');
    expect(completedTurns[0].content).toBe('This is the completed content');
    expect(completedTurns[0].completedAt).not.toBeNull();
      
    const stillInProgress = db.getInProgressTurns('test-conv-3');
    expect(stillInProgress).toHaveLength(0);
  });

  test('should add and retrieve trace entries', () => {
    // Create conversation
    const conversation: Conversation = {
      id: 'test-conv-4',
      createdAt: new Date(),
      agents: [{ id: 'agent-1', strategyType: 'static_replay', script: [] } as StaticReplayConfig],
      turns: [],
      status: 'active',
      metadata: { conversationTitle: 'Trace Test' }
    };
    db.createConversation(conversation);
      
    const traceEntry: ThoughtEntry = {
      id: 'trace-1',
      agentId: 'agent-1',
      timestamp: new Date('2024-01-01T02:00:00Z'),
      type: 'thought',
      content: 'I am thinking about this problem'
    };
      
    db.addTraceEntry('test-conv-4', traceEntry);
      
    const allTraces = db.getAllTraceEntries('test-conv-4');
    expect(allTraces).toHaveLength(1);
    expect(allTraces[0].id).toBe('trace-1');
    expect(allTraces[0].type).toBe('thought');
    expect((allTraces[0] as ThoughtEntry).content).toBe('I am thinking about this problem');
  });

  test('should create and validate agent tokens', () => {
    // First create a conversation (needed for foreign key)
    const conversation: Conversation = {
      id: 'conv-1',
      createdAt: new Date(),
      metadata: { conversationTitle: 'Token Test' },
      agents: [{ id: 'agent-1', strategyType: 'static_replay', script: [] } as StaticReplayConfig],
      turns: [],
      status: 'active'
    };
    db.createConversation(conversation);
      
    db.createAgentToken('test-token-123', 'conv-1', 'agent-1', 3600000); // 1 hour
      
    const validation = db.validateToken('test-token-123');
    expect(validation).not.toBeNull();
    expect(validation!.conversationId).toBe('conv-1');
    expect(validation!.agentId).toBe('agent-1');
  });

  test('should not validate expired tokens', () => {
    // First create a conversation (needed for foreign key)
    const conversation: Conversation = {
      id: 'conv-expired',
      createdAt: new Date(),
      agents: [{ id: 'agent-1', strategyType: 'static_replay', script: [] } as StaticReplayConfig],
      metadata: { conversationTitle: 'Expired Token Test' },
      turns: [],
      status: 'active'
    };
    db.createConversation(conversation);
      
    db.createAgentToken('expired-token', 'conv-expired', 'agent-1', -1000); // Expired 1 second ago
      
    const validation = db.validateToken('expired-token');
    expect(validation).toBeNull();
  });

  test('should return null for non-existent conversation', () => {
    const nonExistent = db.getConversation('non-existent-id');
    expect(nonExistent).toBeNull();
  });

  test('should update conversation status', () => {
    // Create conversation
    const conversation: Conversation = {
      id: 'test-conv-status',
      createdAt: new Date(),
      agents: [],
      turns: [],
      status: 'active',
      metadata: { conversationTitle: 'Status Test' }
    };
    db.createConversation(conversation);
      
    db.updateConversationStatus('test-conv-status', 'completed');
      
    const updated = db.getConversation('test-conv-status', false);
    expect(updated!.status).toBe('completed');
  });
});