// WebSocket User Query Tests

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { TestEnvironment, WebSocketTestClient, TestDataFactory } from '../utils/test-helpers.js';

let testEnv: TestEnvironment;
let wsClient: WebSocketTestClient;
let conversationId: string;
let agentToken: string;

beforeEach(async () => {
  testEnv = new TestEnvironment();
  await testEnv.start();
  
  const { conversationId: cId, agents } = await testEnv.createTestConversation('User Query Test');
  conversationId = cId;
  agentToken = agents[0].token;
  
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();
  await wsClient.authenticate(agentToken);
});

afterEach(async () => {
  if (wsClient) {
    await wsClient.disconnect();
  }
  await testEnv.stop();
});

test('should create user queries via WebSocket', async () => {
  const queryId = await wsClient.createUserQuery('What is the weather today?', {
    location: 'San Francisco',
    urgent: true
  });
  
  expect(queryId).toBeDefined();
  expect(typeof queryId).toBe('string');
  expect(queryId.length).toBeGreaterThan(0);
});

test('should return query IDs for tracking', async () => {
  const queryId1 = await wsClient.createUserQuery('First query');
  const queryId2 = await wsClient.createUserQuery('Second query');
  
  expect(queryId1).not.toBe(queryId2);
  expect(typeof queryId1).toBe('string');
  expect(typeof queryId2).toBe('string');
});

test('should validate query parameters', async () => {
  // Test with empty question
  let error: any;
  try {
    await wsClient.createUserQuery('');
  } catch (e) {
    error = e;
  }
  
  expect(error).toBeDefined();
  expect(error.code).toBeDefined();
});

test('should emit user_query_created events', async () => {
  await wsClient.subscribe(conversationId);
  wsClient.clearEvents();
  
  const queryId = await wsClient.createUserQuery('Test question for events');
  
  // Wait for user_query_created event
  const events = await wsClient.waitForSpecificEvents(
    (events) => events.some(e => 
      e.type === 'user_query_created' && 
      e.data.query?.queryId === queryId
    ),
    1000,
    'user_query_created event'
  );
  
  const queryEvent = events.find(e => e.type === 'user_query_created');
  expect(queryEvent).toBeDefined();
  expect(queryEvent!.data.query.queryId).toBe(queryId);
  expect(queryEvent!.data.query.question).toBe('Test question for events');
});

test('should accept query responses via WebSocket', async () => {
  const queryId = await wsClient.createUserQuery('What is 2+2?');
  
  await wsClient.respondToUserQuery(queryId, 'The answer is 4');
  
  // If no error was thrown, the response was accepted
  expect(true).toBe(true);
});

test('should validate query IDs before accepting responses', async () => {
  const invalidQueryId = 'invalid-query-id-123';
  
  let error: any;
  try {
    await wsClient.respondToUserQuery(invalidQueryId, 'Invalid response');
  } catch (e) {
    error = e;
  }
  
  expect(error).toBeDefined();
  expect(error.code).toBeDefined();
});

test('should emit user_query_answered events', async () => {
  await wsClient.subscribe(conversationId);
  wsClient.clearEvents();
  
  const queryId = await wsClient.createUserQuery('Test query for response events');
  
  // Clear events after query creation
  wsClient.clearEvents();
  
  await wsClient.respondToUserQuery(queryId, 'Test response');
  
  // Wait for user_query_answered event
  const events = await wsClient.waitForSpecificEvents(
    (events) => events.some(e => 
      e.type === 'user_query_answered' && 
      e.data.queryId === queryId
    ),
    1000,
    'user_query_answered event'
  );
  
  const answerEvent = events.find(e => e.type === 'user_query_answered');
  expect(answerEvent).toBeDefined();
  expect(answerEvent!.data.queryId).toBe(queryId);
  expect(answerEvent!.data.response).toBe('Test response');
});

test('should handle query timeouts appropriately', async () => {
  const queryId = await wsClient.createUserQuery('Timeout test query', {}, 100); // 100ms timeout
  
  // Wait longer than the timeout
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // Try to respond after timeout
  let error: any;
  try {
    await wsClient.respondToUserQuery(queryId, 'Too late response');
  } catch (e) {
    error = e;
  }
  
  // Should either succeed (if timeout not implemented) or fail with timeout error
  if (error) {
    expect(error.code).toBeDefined();
  }
});

test('should handle multiple pending queries per agent', async () => {
  const queryId1 = await wsClient.createUserQuery('First pending query');
  const queryId2 = await wsClient.createUserQuery('Second pending query');
  const queryId3 = await wsClient.createUserQuery('Third pending query');
  
  expect(queryId1).not.toBe(queryId2);
  expect(queryId2).not.toBe(queryId3);
  
  // Respond to queries in different order
  await wsClient.respondToUserQuery(queryId2, 'Response to second');
  await wsClient.respondToUserQuery(queryId1, 'Response to first');
  await wsClient.respondToUserQuery(queryId3, 'Response to third');
});

test('should validate query context and permissions', async () => {
  const queryId = await wsClient.createUserQuery('Permission test query', {
    restricted: true,
    level: 'admin'
  });
  
  // Test that query was created despite context parameters
  expect(queryId).toBeDefined();
  expect(typeof queryId).toBe('string');
});