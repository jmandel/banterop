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
      
    const createResponse = await testEnv.orchestrator.createConversation({
      metadata: { conversationTitle: 'Test Reconnection' },
      agents: [{
        id: "test-agent",
        strategyType: 'scenario_driven',
        scenarioId: 'test-scenario'
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
      
    client.on('stateChange', (change: { from: string; to: string }) => {
      stateChanges.push(change);
    });
      
    expect(client.getConnectionState()).toBe('disconnected');
      
    await client.connect(authToken);
    expect(client.getConnectionState()).toBe('ready');
      
    expect(stateChanges.some(s => s.from === 'disconnected' && s.to === 'connecting')).toBe(true);
    expect(stateChanges.some(s => s.from === 'connecting' && s.to === 'ready')).toBe(true);
  });

  test('client automatically reconnects after disconnect', async () => {
    const stateChanges: Array<{ from: string; to: string }> = [];
      
    client.on('stateChange', (change: { from: string; to: string }) => {
      stateChanges.push(change);
    });
    
    await client.connect(authToken);
    expect(client.getConnectionState()).toBe('ready');
      
    stateChanges.length = 0;
      
    await client.simulateReconnect();
      
    expect(client.getConnectionState()).toBe('ready');
    const transitions = stateChanges.map(s => `${s.from}->${s.to}`);
    expect(transitions).toContain('ready->disconnected');
    expect(transitions).toContain('disconnected->connecting');
    expect(transitions[transitions.length - 1]).toBe('rehydrating->ready');
  });

  test('client re-subscribes to conversations after reconnect', async () => {
    const events: ConversationEvent[] = [];
      
    client.on('event', (event) => {
      events.push(event);
    });
    
    await client.connect(authToken);
    await client.subscribe(conversationId);
      
    const turnId = await client.startTurn();
    await client.completeTurn(turnId, 'Test message before disconnect');
      
    await waitForCondition(() => events.some(e => e.type === 'turn_completed'), 2000);
    const eventCountBefore = events.length;
      
    await client.simulateReconnect();
      
    expect(events.some(e => e.type === 'rehydrated')).toBe(true);
      
    const turnId2 = await client.startTurn();
    await client.completeTurn(turnId2, 'Test message after reconnect');
      
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
      
    const turnId = await client.startTurn();
    await client.addTrace(turnId, TestDataFactory.createTraceEntryPartial('thought', 'Test thought'));
    await client.addTrace(turnId, TestDataFactory.createTraceEntryPartial('tool_call', {
      toolName: 'test_tool', 
      parameters: { param: 'value' }, 
      toolCallId: 'test-call-1' 
    }));
    await client.completeTurn(turnId, 'Test turn with trace');
      
    await waitForCondition(() => events.some(e => e.type === 'turn_completed'), 2000);
      
    events.length = 0;
    await client.simulateReconnect();
      
    const rehydratedEvent = events.find(e => e.type === 'rehydrated');
    expect(rehydratedEvent).toBeTruthy();
      
    const snapshot = rehydratedEvent!.data.conversation;
    expect(snapshot.id).toBe(conversationId);
    expect(snapshot.turns).toBeTruthy();
    expect(snapshot.turns.length).toBeGreaterThan(0);
      
    const turn = snapshot.turns[0];
    expect(turn.trace).toBeTruthy();
    expect(turn.trace.length).toBeGreaterThan(0);
    expect(turn.trace.some((t: any) => t.type === 'thought')).toBe(true);
    expect(turn.trace.some((t: any) => t.type === 'tool_call')).toBe(true);
  });

  test('client preserves auth token across reconnections', async () => {
    await client.connect(authToken);
      
    const turnId1 = await client.startTurn();
    await client.completeTurn(turnId1, 'Before disconnect');
      
    for (let i = 0; i < 3; i++) {
      await client.simulateReconnect();
      
      const turnId = await client.startTurn();
      await client.completeTurn(turnId, `After reconnect ${i + 1}`);
    }
  });

  test('client handles multiple subscriptions during rehydration', async () => {
    // Create another conversation
    const createResponse2 = await testEnv.orchestrator.createConversation({
      metadata: { conversationTitle: 'Second Conversation' },
      agents: [{
        id: "test-agent",
        strategyType: 'scenario_driven',
        scenarioId: 'test-scenario'
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
      
    await client.subscribe(conversationId);
    await client.subscribe(conversationId2);
      
    await client.simulateReconnect();
      
    await waitForCondition(() => rehydratedEvents.length >= 2, 5000);
      
    const conversationIds = rehydratedEvents.map(e => e.data.conversation.id);
    expect(conversationIds).toContain(conversationId);
    expect(conversationIds).toContain(conversationId2);
  });

  test('client connection state transitions correctly during rehydration', async () => {
    const stateChanges: Array<{ from: string; to: string }> = [];
      
    client.on('stateChange', (change: { from: string; to: string }) => {
      stateChanges.push(change);
    });
    
    await client.connect(authToken);
    await client.subscribe(conversationId);
      
    stateChanges.length = 0;
      
    await client.simulateReconnect();
      
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