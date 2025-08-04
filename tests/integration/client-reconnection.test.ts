import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { TestEnvironment, WebSocketTestClient, TestDataFactory, waitForCondition } from '../utils/test-helpers.js';
import type { ConversationEvent, ThoughtEntry, ToolCallEntry } from '$lib/types.js';

describe('Client Reconnection and Rehydration', () => {
  let testEnv: TestEnvironment;
  let client: WebSocketTestClient;
  let authToken: string;
  let conversationId: string;

  beforeEach(async () => {
    testEnv = new TestEnvironment();
    await testEnv.start();
    
    // Create a conversation for testing
    const createResponse = await testEnv.orchestrator.createConversation({
      name: 'Test Reconnection',
      managementMode: 'external',
      agents: [{
        agentId: { id: 'test-agent', label: 'Test Agent', role: 'assistant' },
        strategyType: 'scenario_driven',
        scenarioConfig: {
          principalIdentity: 'test',
          promptStyle: 'markdown',
          toolTasks: []
        }
      }]
    });
    
    conversationId = createResponse.conversation.id;
    authToken = createResponse.agentTokens['test-agent'];
    client = new WebSocketTestClient(testEnv.wsUrl!);
  });

  afterEach(async () => {
    client?.disconnect();
    await testEnv?.stop();
  });

  test('client maintains connection state machine', async () => {
    const stateChanges: Array<{ from: string; to: string }> = [];
    
    // Track state changes via events
    client.on('stateChange', (change: { from: string; to: string }) => {
      stateChanges.push(change);
    });
    
    // Initial state should be disconnected
    expect(client.getConnectionState()).toBe('disconnected');
    
    // Connect
    await client.connect(authToken);
    expect(client.getConnectionState()).toBe('ready');
    
    // Verify connection state transitions
    expect(stateChanges.some(s => s.from === 'disconnected' && s.to === 'connecting')).toBe(true);
    expect(stateChanges.some(s => s.from === 'connecting' && s.to === 'ready')).toBe(true);
  });

  test('client automatically reconnects after disconnect', async () => {
    const stateChanges: Array<{ from: string; to: string }> = [];
    
    // Track state changes
    client.on('stateChange', (change: { from: string; to: string }) => {
      stateChanges.push(change);
    });
    
    await client.connect(authToken);
    expect(client.getConnectionState()).toBe('ready');
    
    // Clear state tracking for reconnection
    stateChanges.length = 0;
    
    // Force reconnection
    await client.simulateReconnect();
    
    // Verify we went through disconnection and back to ready
    expect(client.getConnectionState()).toBe('ready');
    const transitions = stateChanges.map(s => `${s.from}->${s.to}`);
    expect(transitions).toContain('ready->disconnected');
    expect(transitions).toContain('disconnected->connecting');
    expect(transitions[transitions.length - 1]).toBe('rehydrating->ready');
  });

  test('client re-subscribes to conversations after reconnect', async () => {
    const events: ConversationEvent[] = [];
    
    // Track events
    client.on('event', (event) => {
      events.push(event);
    });
    
    await client.connect(authToken);
    await client.subscribe(conversationId);
    
    // Create a turn before disconnect
    const turnId = await client.startTurn();
    await client.completeTurn(turnId, 'Test message before disconnect');
    
    // Wait for turn event
    await waitForCondition(() => events.some(e => e.type === 'turn_completed'), 2000);
    const eventCountBefore = events.length;
    
    // Force reconnection
    await client.simulateReconnect();
    
    // Should have received rehydration event
    expect(events.some(e => e.type === 'rehydrated')).toBe(true);
    
    // Create another turn after reconnect
    const turnId2 = await client.startTurn();
    await client.completeTurn(turnId2, 'Test message after reconnect');
    
    // Should receive events for the new turn
    await waitForCondition(() => events.some(e => 
      e.type === 'turn_completed' && 
      e.data.turn.content === 'Test message after reconnect'
    ), 2000);
  });

  test('client emits rehydrated event with full conversation snapshot', async () => {
    const events: ConversationEvent[] = [];
    
    client.on('event', (event) => {
      events.push(event);
    });
    
    await client.connect(authToken);
    await client.subscribe(conversationId);
    
    // Create some conversation state
    const turnId = await client.startTurn();
    await client.addTrace(turnId, TestDataFactory.createTraceEntryPartial('thought', 'Test thought'));
    await client.addTrace(turnId, TestDataFactory.createTraceEntryPartial('tool_call', {
      toolName: 'test_tool', 
      parameters: { param: 'value' }, 
      toolCallId: 'test-call-1' 
    }));
    await client.completeTurn(turnId, 'Test turn with trace');
    
    // Wait for turn completion
    await waitForCondition(() => events.some(e => e.type === 'turn_completed'), 2000);
    
    // Clear events and force reconnection
    events.length = 0;
    await client.simulateReconnect();
    
    // Find rehydrated event
    const rehydratedEvent = events.find(e => e.type === 'rehydrated');
    expect(rehydratedEvent).toBeTruthy();
    
    // Verify snapshot contents
    const snapshot = rehydratedEvent!.data.conversation;
    expect(snapshot.id).toBe(conversationId);
    expect(snapshot.turns).toBeTruthy();
    expect(snapshot.turns.length).toBeGreaterThan(0);
    
    // Verify turn has trace entries
    const turn = snapshot.turns[0];
    expect(turn.trace).toBeTruthy();
    expect(turn.trace.length).toBeGreaterThan(0);
    expect(turn.trace.some((t: any) => t.type === 'thought')).toBe(true);
    expect(turn.trace.some((t: any) => t.type === 'tool_call')).toBe(true);
  });

  test('client preserves auth token across reconnections', async () => {
    await client.connect(authToken);
    
    // Create a turn to verify auth works
    const turnId1 = await client.startTurn();
    await client.completeTurn(turnId1, 'Before disconnect');
    
    // Force multiple reconnections
    for (let i = 0; i < 3; i++) {
      await client.simulateReconnect();
      
      // Should still be able to create turns after each reconnect
      const turnId = await client.startTurn();
      await client.completeTurn(turnId, `After reconnect ${i + 1}`);
    }
  });

  test('client handles multiple subscriptions during rehydration', async () => {
    // Create another conversation
    const createResponse2 = await testEnv.orchestrator.createConversation({
      name: 'Second Conversation',
      managementMode: 'external',
      agents: [{
        agentId: { id: 'test-agent', label: 'Test Agent', role: 'assistant' },
        strategyType: 'scenario_driven',
        scenarioConfig: {
          principalIdentity: 'test',
          promptStyle: 'markdown',
          toolTasks: []
        }
      }]
    });
    const conversationId2 = createResponse2.conversation.id;
    
    const rehydratedEvents: ConversationEvent[] = [];
    client.on('event', (event) => {
      if (event.type === 'rehydrated') {
        rehydratedEvents.push(event);
      }
    });
    
    await client.connect(authToken);
    
    // Subscribe to both conversations
    await client.subscribe(conversationId);
    await client.subscribe(conversationId2);
    
    // Force reconnection
    await client.simulateReconnect();
    
    // Should get rehydration for both conversations
    await waitForCondition(() => rehydratedEvents.length >= 2, 5000);
    
    // Verify we got rehydration for both conversations
    const conversationIds = rehydratedEvents.map(e => e.data.conversation.id);
    expect(conversationIds).toContain(conversationId);
    expect(conversationIds).toContain(conversationId2);
  });

  test('client connection state transitions correctly during rehydration', async () => {
    const stateChanges: Array<{ from: string; to: string }> = [];
    
    // Track state changes
    client.on('stateChange', (change: { from: string; to: string }) => {
      stateChanges.push(change);
    });
    
    await client.connect(authToken);
    await client.subscribe(conversationId);
    
    // Clear for reconnection tracking
    stateChanges.length = 0;
    
    // Force reconnection
    await client.simulateReconnect();
    
    // Verify correct state transition sequence
    const transitions = stateChanges.map(s => `${s.from}->${s.to}`);
    expect(transitions).toEqual([
      'ready->disconnected',
      'disconnected->connecting', 
      'connecting->ready',
      'ready->rehydrating',
      'rehydrating->ready'
    ]);
  });
}); 