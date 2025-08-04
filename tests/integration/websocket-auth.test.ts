// WebSocket Authentication Tests

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { TestEnvironment, WebSocketTestClient, TestDataFactory, TEST_CONFIG } from '../utils/test-helpers.js';

let testEnv: TestEnvironment;
let wsClient: WebSocketTestClient;

beforeEach(async () => {
  testEnv = new TestEnvironment();
  await testEnv.start();
});

afterEach(async () => {
  if (wsClient) {
    await wsClient.disconnect();
  }
  await testEnv.stop();
});

test('should reject unauthenticated requests', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();

  // Try to make an authenticated request without authenticating first
  let authError: any;
  try {
    await wsClient.startTurn({ test: true });
  } catch (error) {
    authError = error;
  }

  expect(authError).toBeDefined();
  expect(authError.code).toBe(-32000); // UNAUTHORIZED
});

test('should accept valid agent tokens', async () => {
  const { conversationId, agents } = await testEnv.createTestConversation('Auth Test');
  
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();

  const authResult = await wsClient.authenticate(agents[0].token);
  
  expect(authResult.success).toBe(true);
  expect(authResult.conversationId).toBe(conversationId);
  expect(authResult.agentId).toBe(agents[0].id);
});

test('should reject invalid tokens', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();

  const invalidToken = 'invalid-token-here';
  
  let authError: any;
  try {
    await wsClient.authenticate(invalidToken);
  } catch (error) {
    authError = error;
  }

  expect(authError).toBeDefined();
  // Should be either INVALID_TOKEN (-32002) or INTERNAL_ERROR (-32603) wrapping it
  expect([-32002, -32603]).toContain(authError.code);
});

test('should maintain authentication across multiple requests', async () => {
  const { conversationId, agents } = await testEnv.createTestConversation('Multi-request Auth');
  
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();

  // Authenticate once
  await wsClient.authenticate(agents[0].token);

  // Multiple operations should work without re-authentication
  await wsClient.subscribe(conversationId);
  const turnId = await wsClient.startTurn({ test: true });
  await wsClient.addTrace(turnId, TestDataFactory.createTraceEntryPartial('thought', 'Test thought'));
  await wsClient.completeTurn(turnId, 'Test completion');

  // All operations should have succeeded (no exceptions thrown)
  expect(true).toBe(true);
});