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
    
    // Create conversation
    const response = await testEnv.orchestrator.createConversation({
      name: 'Test Rehydration',
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
    
    conversationId = response.conversation.id;
    authToken = response.agentTokens['test-agent'];
    
    // Create test client
    client = new WebSocketTestClient(testEnv.wsUrl!);
  });

  afterEach(async () => {
    client?.disconnect();
    await testEnv?.stop();
  });

  test('client receives rehydrated event after reconnection', async () => {
    const events: ConversationEvent[] = [];
    
    // Track events
    client.on('event', (event) => {
      events.push(event);
    });
    
    // Connect and subscribe
    await client.connect(authToken);
    await client.subscribe(conversationId);
    
    // Create some state
    const turnId = await client.startTurn();
    await client.addTrace(turnId, TestDataFactory.createTraceEntryPartial('thought', 'Test thought'));
    await client.completeTurn(turnId, 'Test message');
    
    // Wait for turn completion
    await waitForCondition(() => events.some(e => e.type === 'turn_completed'), 2000);
    
    // Clear events and simulate reconnect
    events.length = 0;
    await client.simulateReconnect();
    
    // Verify rehydrated event
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
    
    // Create turn with attachment
    const turnId = await client.startTurn();
    await client.completeTurn(turnId, 'Message with attachment', false, undefined, [{
      docId: 'test-doc',
      name: 'test.md',
      contentType: 'text/markdown',
      content: '# Test Document'
    }]);
    
    // Wait for completion
    await waitForCondition(() => events.some(e => e.type === 'turn_completed'), 2000);
    
    // Clear and reconnect
    events.length = 0;
    await client.simulateReconnect();
    
    // Verify attachments are included in rehydration
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
    const conversationId2 = response2.conversation.id;
    
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
    
    // Create turns in both
    const turnId1 = await client.startTurn();
    await client.completeTurn(turnId1, 'Message in first conversation');
    
    const turnId2 = await client.startTurn();
    await client.completeTurn(turnId2, 'Message in second conversation');
    
    // Clear and reconnect
    rehydratedEvents.length = 0;
    await client.simulateReconnect();
    
    // Should get rehydration for both conversations
    await waitForCondition(() => rehydratedEvents.length >= 2, 5000);
    
    // Verify both conversations were rehydrated
    const rehydratedIds = rehydratedEvents.map(e => e.data.conversation.id);
    expect(rehydratedIds).toContain(conversationId);
    expect(rehydratedIds).toContain(conversationId2);
  });

  test('client state transitions correctly during rehydration', async () => {
    const stateChanges: Array<{ from: string; to: string }> = [];
    
    // Track state changes
    client.on('stateChange', (change: { from: string; to: string }) => {
      stateChanges.push(change);
    });
    
    await client.connect(authToken);
    await client.subscribe(conversationId);
    
    // Create some state
    const turnId = await client.startTurn();
    await client.completeTurn(turnId, 'Test message');
    
    // Clear state tracking and force reconnection
    stateChanges.length = 0;
    await client.simulateReconnect();
    
    // Verify state transition sequence includes rehydrating
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