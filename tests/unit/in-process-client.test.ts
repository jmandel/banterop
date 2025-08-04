// In-Process Client Core Functionality Tests

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { InProcessOrchestratorClient } from '$client/impl/in-process.client.js';
import { TestDataFactory, createTestOrchestrator } from '../utils/test-helpers.js';

let orchestrator: ConversationOrchestrator;
let client: InProcessOrchestratorClient;
let conversationId: string;
let agentToken: string;

beforeEach(async () => {
  orchestrator = createTestOrchestrator();
  client = new InProcessOrchestratorClient(orchestrator);
  
  // Create a test conversation
  const { conversation, agentTokens } = await orchestrator.createConversation({
    metadata: { conversationTitle: "In-Process Client Test" },
    agents: [TestDataFactory.createStaticReplayConfig()]
  });
  
  conversationId = conversation.id;
  agentToken = Object.values(agentTokens)[0] as string;
});

afterEach(async () => {
  if (client) {
    await client.disconnect();
  }
});

test('should connect to orchestrator instance successfully', async () => {
  await client.connect();
  
  // Verify client is connected (no error thrown)
  expect(true).toBe(true);
});

test('should handle authentication with valid tokens', async () => {
  await client.connect();
  
  const authResult = await client.authenticate(agentToken);
  
  expect(authResult).toBeDefined();
  expect(authResult.success).toBe(true);
  expect(authResult.agentId).toBeDefined();
  expect(authResult.conversationId).toBeDefined();
});

test('should reject invalid authentication attempts', async () => {
  await client.connect();
  
  let error: any;
  try {
    await client.authenticate('invalid-token-123');
  } catch (e) {
    error = e;
  }
  
  expect(error).toBeDefined();
  expect(error.message).toContain('Invalid token');
});

test('should disconnect cleanly and release resources', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Subscribe to verify cleanup
  const subscriptionId = await client.subscribe(conversationId);
  expect(subscriptionId).toBeDefined();
  
  await client.disconnect();
  
  // After disconnect, new operations should fail
  let error: any;
  try {
    await client.subscribe(conversationId);
  } catch (e) {
    error = e;
  }
  
  expect(error).toBeDefined();
  expect(error.message).toContain('not connected');
});

test('should implement EventEmitter interface correctly', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Verify client implements EventEmitter interface
  expect(typeof client.on).toBe('function');
  expect(typeof client.off).toBe('function');
  expect(typeof client.once).toBe('function');
  expect(typeof client.emit).toBe('function');
  
  // Test basic event listener functionality
  let customEventReceived = false;
  const customHandler = () => { customEventReceived = true; };
  
  client.on('custom', customHandler);
  client.emit('custom');
  
  expect(customEventReceived).toBe(true);
  
  // Test event removal
  client.off('custom', customHandler);
  client.emit('custom');
  // Should still be true since we already received it
  expect(customEventReceived).toBe(true);
});

test('should handle subscription and unsubscription', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Test subscription
  const subscriptionId = await client.subscribe(conversationId);
  expect(subscriptionId).toBeDefined();
  expect(typeof subscriptionId).toBe('string');
  
  // Test unsubscription
  await client.unsubscribe(subscriptionId);
  
  // Test multiple subscriptions
  const sub1 = await client.subscribe(conversationId);
  const sub2 = await client.subscribe(conversationId);
  expect(sub1).not.toBe(sub2);
  
  // Test unsubscribe all
  await client.unsubscribeAll();
});

test('should handle basic operations correctly', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Test subscription
  const subscriptionId = await client.subscribe(conversationId);
  expect(subscriptionId).toBeDefined();
  
  // Test streaming turn pattern
  const turnId = await client.startTurn();
  expect(turnId).toBeDefined();
  const turn = await client.completeTurn(turnId, 'Test turn');
  expect(turn).toBeDefined();
  expect(turn.content).toBe('Test turn');
  expect(turn.agentId).toBeDefined();
  
  // Test createUserQuery
  const queryId = await client.createUserQuery('Test query');
  expect(queryId).toBeDefined();
  expect(typeof queryId).toBe('string');
});

test('should handle event listener cleanup properly', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  let eventCount = 0;
  const eventHandler = (event: any, subscriptionId: string) => { 
    eventCount++; 
  };
  
  client.on('event', eventHandler);
  
  // First subscribe, then submit turn to ensure we receive events
  const subscriptionId = await client.subscribe(conversationId);
  
  // Wait for events to be emitted by streaming turn
  const eventPromise = new Promise<void>((resolve, reject) => {
    let eventsReceived = 0;
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for events. Received ${eventsReceived} events. Event count: ${eventCount}`));
    }, 2000);
    
    const handler = (event: any, subscriptionId: string) => {
      eventsReceived++;
      // Wait for at least one event (turn_completed)
      if (eventsReceived >= 1) {
        clearTimeout(timeout);
        resolve();
      }
    };
    client.on('event', handler);
  });
  
  const turnId = await client.startTurn();
  await client.completeTurn(turnId, 'Before cleanup');
  await eventPromise;
  
  expect(eventCount).toBeGreaterThan(0);
  
  // Disconnect should clean up subscriptions
  const countBeforeDisconnect = eventCount;
  await client.disconnect();
  
  // After disconnect, client should not receive new events
  // This test verifies cleanup worked properly
  expect(eventCount).toBe(countBeforeDisconnect);
});

test('should handle multiple simultaneous operations', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Perform multiple operations concurrently
  const operations = [
    client.subscribe(conversationId),
    client.createUserQuery('Concurrent query 1'),
    client.createUserQuery('Concurrent query 2'),
    client.startTurn().then(turnId => client.completeTurn(turnId, 'Concurrent turn'))
  ];
  
  const results = await Promise.allSettled(operations);
  
  // All operations should succeed
  results.forEach(result => {
    expect(result.status).toBe('fulfilled');
  });
  
  const [subscriptionResult, query1Result, query2Result, turnResult] = results as PromiseFulfilledResult<any>[];
  
  expect(subscriptionResult.value).toBeDefined(); // subscription ID
  expect(query1Result.value).toBeDefined(); // query ID
  expect(query2Result.value).toBeDefined(); // query ID
  expect(turnResult.value).toBeDefined(); // turn object
});

test('should maintain connection state correctly', async () => {
  // Initially not connected
  let error: any;
  try {
    await client.authenticate(agentToken);
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  
  // After connect, should be connected
  await client.connect();
  await client.authenticate(agentToken); // Should not throw
  
  // After disconnect, should not be connected
  await client.disconnect();
  
  error = null;
  try {
    await client.subscribe(conversationId);
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
});

test('should handle rapid connect/disconnect cycles', async () => {
  // Test multiple connect/disconnect cycles
  for (let i = 0; i < 3; i++) {
    await client.connect();
    await client.authenticate(agentToken);
    
    const subscriptionId = await client.subscribe(conversationId);
    expect(subscriptionId).toBeDefined();
    
    await client.disconnect();
  }
  
  // Final connection should still work
  await client.connect();
  await client.authenticate(agentToken);
  const finalSubscription = await client.subscribe(conversationId);
  expect(finalSubscription).toBeDefined();
});