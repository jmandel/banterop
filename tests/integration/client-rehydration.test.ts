import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { TestEnvironment, waitForCondition, WebSocketTestClient, TestDataFactory } from '../utils/test-helpers.js';
import type { ConversationEvent, ThoughtEntry } from '$lib/types.js';

describe('Client Rehydration', () => {
  let testEnv: TestEnvironment;
  let client: WebSocketTestClient;
  let conversationId: string;
  let authToken: string;

  beforeEach(async () => {
    testEnv = new TestEnvironment();
    await testEnv.start();
      
    const response = await testEnv.orchestrator.createConversation({
      metadata: { conversationTitle: 'Test Rehydration' },
      agents: [{
        id: "test-agent",
        strategyType: 'scenario_driven',
        scenarioId: 'test-scenario'
      }]
    });
    
    conversationId = response.conversation.id;
    authToken = response.agentTokens['test-agent'];
      
    client = new WebSocketTestClient(testEnv.wsUrl!);
  });

  afterEach(async () => {
    client?.disconnect();
    await testEnv?.stop();
  });

  test('client receives rehydrated event after reconnection', async () => {
    const events: ConversationEvent[] = [];
      
    client.on('event', (event) => {
      events.push(event);
    });
      
    await client.connect(authToken);
    await client.subscribe(conversationId);
      
    const turnId = await client.startTurn();
    await client.addTrace(turnId, TestDataFactory.createTraceEntryPartial('thought', 'Test thought'));
    await client.completeTurn(turnId, 'Test message');
      
    await waitForCondition(() => events.some(e => e.type === 'turn_completed'), 2000);
      
    events.length = 0;
    await client.simulateReconnect();
      
    const rehydratedEvent = events.find(e => e.type === 'rehydrated');
    expect(rehydratedEvent).toBeTruthy();
    expect(rehydratedEvent!.data.conversation).toBeTruthy();
    expect(rehydratedEvent!.data.conversation.id).toBe(conversationId);
    expect(rehydratedEvent!.data.conversation.turns).toBeTruthy();
    expect(rehydratedEvent!.data.conversation.turns.length).toBeGreaterThan(0);
  });

  test('client rehydrates with attachments', async () => {
    const events: ConversationEvent[] = [];
    
    client.on('event', (event) => {
      events.push(event);
    });
    
    await client.connect(authToken);
    await client.subscribe(conversationId);
      
    const turnId = await client.startTurn();
    await client.completeTurn(turnId, 'Message with attachment', false, undefined, [{
      docId: 'test-doc',
      name: 'test.md',
      contentType: 'text/markdown',
      content: '# Test Document'
    }]);
      
    await waitForCondition(() => events.some(e => e.type === 'turn_completed'), 2000);
      
    events.length = 0;
    await client.simulateReconnect();
      
    const rehydratedEvent = events.find(e => e.type === 'rehydrated');
    expect(rehydratedEvent).toBeTruthy();
    
    const conversation = rehydratedEvent!.data.conversation;
    expect(conversation.attachments).toBeTruthy();
    expect(conversation.attachments.length).toBe(1);
    expect(conversation.attachments[0].docId).toBe('test-doc');
    expect(conversation.attachments[0].content).toBe('# Test Document');
  });

  test('client rehydrates multiple conversations', async () => {
    // Create second conversation
    const response2 = await testEnv.orchestrator.createConversation({
      metadata: { conversationTitle: 'Second Conversation' },
      agents: [{
        id: "test-agent",
        strategyType: 'scenario_driven',
        scenarioId: 'test-scenario'
      }]
    });
    const conversationId2 = response2.conversation.id;
    
    const rehydratedEvents: ConversationEvent[] = [];
    client.on('event', (event) => {
      if (event.type === 'rehydrated') {
        rehydratedEvents.push(event);
      }
    });
    
    await client.connect(authToken);
      
    await client.subscribe(conversationId);
    await client.subscribe(conversationId2);
      
    const turnId1 = await client.startTurn();
    await client.completeTurn(turnId1, 'Message in first conversation');
    
    const turnId2 = await client.startTurn();
    await client.completeTurn(turnId2, 'Message in second conversation');
      
    rehydratedEvents.length = 0;
    await client.simulateReconnect();
      
    await waitForCondition(() => rehydratedEvents.length >= 2, 5000);
      
    const rehydratedIds = rehydratedEvents.map(e => e.data.conversation.id);
    expect(rehydratedIds).toContain(conversationId);
    expect(rehydratedIds).toContain(conversationId2);
  });

  test('client state transitions correctly during rehydration', async () => {
    const stateChanges: Array<{ from: string; to: string }> = [];
      
    client.on('stateChange', (change: { from: string; to: string }) => {
      stateChanges.push(change);
    });
    
    await client.connect(authToken);
    await client.subscribe(conversationId);
      
    const turnId = await client.startTurn();
    await client.completeTurn(turnId, 'Test message');
      
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