import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { TestEnvironment, WebSocketTestClient, waitForCondition } from '../utils/test-helpers.js';

describe('Simple Reconnection Test', () => {
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

  test('captures all state transitions during reconnection', async () => {
    const stateChanges: Array<{ from: string; to: string }> = [];
    const events: string[] = [];
      
    client.on('stateChange', (change: { from: string; to: string }) => {
      stateChanges.push(change);
    });
      
    client.on('event', (event) => {
      events.push(event.type);
    });
      
    await client.connect(authToken);
    await client.subscribe(conversationId);
    const turnId = await client.startTurn();
    await client.completeTurn(turnId, 'Test message');
    await waitForCondition(() => events.includes('turn_completed'), 2000);
      
    stateChanges.length = 0;
    events.length = 0;
      
    await client.simulateReconnect();
      
    const transitions = stateChanges.map(s => `${s.from}->${s.to}`);
    expect(transitions).toEqual([
      'ready->disconnected',
      'disconnected->connecting', 
      'connecting->ready',
      'ready->rehydrating',
      'rehydrating->ready'
    ]);
      
    expect(events).toContain('rehydrated');
    expect(client.getConnectionState()).toBe('ready');
  });
});