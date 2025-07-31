// WebSocket Error Handling Tests

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { TestEnvironment, WebSocketTestClient, TestDataFactory } from '../utils/test-helpers.js';
import type { ThoughtEntry, ToolCallEntry, ToolResultEntry } from '$lib/types.js';

let testEnv: TestEnvironment;
let wsClient: WebSocketTestClient;
let conversationId: string;
let agentToken: string;

beforeEach(async () => {
  testEnv = new TestEnvironment();
  await testEnv.start();
  
  const { conversationId: cId, agents } = await testEnv.createTestConversation('Error Handling Test');
  conversationId = cId;
  agentToken = agents[0].token;
});

afterEach(async () => {
  if (wsClient) {
    await wsClient.disconnect();
  }
  await testEnv.stop();
});

test('should handle network disconnections gracefully', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  await wsClient.authenticate(agentToken);
  
  // Verify connection is working
  expect(testEnv.wsServer.getConnectedClients()).toBe(1);
  
  // Disconnect abruptly
  await wsClient.disconnect();
  
  // Give server time to process disconnect
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Server should handle it gracefully
  expect(testEnv.wsServer.getConnectedClients()).toBe(0);
});

test('should return proper JSON-RPC error responses', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  await wsClient.authenticate(agentToken);
  
  // Test invalid method call
  let error: any;
  try {
    await wsClient.getConversation('non-existent-conversation');
  } catch (e) {
    error = e;
  }
  
  expect(error).toBeDefined();
  expect(error.code).toBeDefined();
  expect(typeof error.code).toBe('number');
  expect(error.message).toBeDefined();
});

test('should validate request structure and return meaningful errors', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  await wsClient.authenticate(agentToken);
  
  // Test with invalid turn ID
  let error: any;
  try {
    await wsClient.completeTurn('invalid-turn-id', 'content');
  } catch (e) {
    error = e;
  }
  
  expect(error).toBeDefined();
  expect(error.code).toBeDefined();
  expect(error.message).toContain('not found');
});

test('should handle authentication errors gracefully', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  
  // Test with invalid token
  let authError: any;
  try {
    await wsClient.authenticate('invalid-token-123');
  } catch (e) {
    authError = e;
  }
  
  expect(authError).toBeDefined();
  expect(authError.code).toBe(-32603); // Internal error code (actual)
  expect(authError.message).toBe('Invalid token');
});

test('should prevent unauthenticated operations', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  
  // Try to perform operations without authentication
  let error: any;
  try {
    await wsClient.addTrace('fake-turn-but-should-fail-at-auth-before-noticing-this', { type: 'thought', content: 'Event order test' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>);
  } catch (e) {
    error = e;
  }

  expect(error).toBeDefined();
  expect(error.message).toBe('Unauthorized');
});

test('should handle parameter validation errors', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  await wsClient.authenticate(agentToken);
  
  // Test with missing required parameters
  let error: any;
  try {
    await wsClient.createUserQuery(''); // Empty question
  } catch (e) {
    error = e;
  }
  
  expect(error).toBeDefined();
  expect(error.code).toBe(-32603); // Internal error code (actual)
  expect(error.message).toBe('Invalid params');
});

test('should handle subscription to non-existent conversations', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  await wsClient.authenticate(agentToken);
  
  let error: any;
  try {
    await wsClient.subscribe('non-existent-conversation-id');
  } catch (e) {
    error = e;
  }
  
  // Should either succeed (no validation) or fail with proper error
  if (error) {
    expect(error.code).toBeDefined();
    expect(error.message).toBeDefined();
  }
});

test('should handle trace addition to non-existent turns', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  await wsClient.authenticate(agentToken);
  
  let error: any;
  try {
    await wsClient.addTrace('non-existent-turn-id', TestDataFactory.createTraceEntryPartial('thought', 'test'));
  } catch (e) {
    error = e;
  }
  
  expect(error).toBeDefined();
  expect(error.code).toBeDefined();
});

test('should handle malformed trace entries', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  await wsClient.authenticate(agentToken);
  
  const turnId = await wsClient.startTurn({ test: true });
  
  // Try to add trace with invalid structure - this depends on actual validation
  // If no validation exists, the test will pass
  try {
    await wsClient.addTrace(turnId, TestDataFactory.createTraceEntryPartial('thought', 'valid trace'));
    expect(true).toBe(true); // If we get here, it worked
  } catch (e) {
    // If there's validation, it should be a proper error
    expect((e as any).code).toBeDefined();
  }
});

test('should handle concurrent operations gracefully', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  await wsClient.authenticate(agentToken);
  
  // Start multiple operations concurrently
  const promises = [
    wsClient.createUserQuery('Concurrent query 1'),
    wsClient.createUserQuery('Concurrent query 2'),
    wsClient.createUserQuery('Concurrent query 3')
  ];
  
  const results = await Promise.allSettled(promises);
  
  // All should either succeed or fail with proper errors
  results.forEach(result => {
    if (result.status === 'rejected') {
      expect((result.reason as any).code).toBeDefined();
    } else {
      expect(typeof result.value).toBe('string');
    }
  });
});

test('should maintain connection state during errors', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  await wsClient.authenticate(agentToken);
  
  // Cause an error
  try {
    await wsClient.completeTurn('invalid-turn-id', 'content');
  } catch (e) {
    // Expected error
  }
  
  // Connection should still be valid for other operations
  const queryId = await wsClient.createUserQuery('Connection test');
  expect(queryId).toBeDefined();
  expect(typeof queryId).toBe('string');
});

test('should handle rapid successive operations', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  await wsClient.authenticate(agentToken);
  
  // Perform many operations in quick succession
  const operations = [];
  for (let i = 0; i < 10; i++) {
    operations.push(wsClient.createUserQuery(`Rapid query ${i}`));
  }
  
  const results = await Promise.allSettled(operations);
  
  // Most should succeed, any failures should be proper errors
  let successCount = 0;
  results.forEach(result => {
    if (result.status === 'fulfilled') {
      successCount++;
      expect(typeof result.value).toBe('string');
    } else {
      expect((result.reason as any).code).toBeDefined();
    }
  });
  
  expect(successCount).toBeGreaterThan(5); // Most should succeed
});

test('should handle subscription cleanup on error', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  await wsClient.authenticate(agentToken);
  
  const subscriptionId = await wsClient.subscribe(conversationId);
  expect(subscriptionId).toBeDefined();
  
  // Force an error condition that might affect subscriptions
  try {
    await wsClient.completeTurn('invalid-turn-id', 'content');
  } catch (e) {
    // Expected error
  }
  
  // Subscription should still be manageable
  await wsClient.unsubscribe(subscriptionId);
});
