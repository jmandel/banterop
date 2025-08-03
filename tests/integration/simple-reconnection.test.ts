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
    
    // Create a conversation
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

  test('captures all state transitions during reconnection', async () => {
    const stateChanges: Array<{ from: string; to: string }> = [];
    const events: string[] = [];
    
    // Track state changes
    client.on('stateChange', (change: { from: string; to: string }) => {
      stateChanges.push(change);
    });
    
    // Track events
    client.on('event', (event) => {
      events.push(event.type);
    });
    
    // Connect and create some state
    await client.connect(authToken);
    await client.subscribe(conversationId);
    const turnId = await client.startTurn();
    await client.completeTurn(turnId, 'Test message');
    await waitForCondition(() => events.includes('turn_completed'), 2000);
    
    // Clear tracking for reconnection
    stateChanges.length = 0;
    events.length = 0;
    
    // Force reconnection
    await client.simulateReconnect();
    
    // Verify state transitions
    const transitions = stateChanges.map(s => `${s.from}->${s.to}`);
    expect(transitions).toEqual([
      'ready->disconnected',
      'disconnected->connecting', 
      'connecting->ready',
      'ready->rehydrating',
      'rehydrating->ready'
    ]);
    
    // Verify we got rehydration event
    expect(events).toContain('rehydrated');
    expect(client.getConnectionState()).toBe('ready');
  });
});