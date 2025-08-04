// In-Process User Query Tests

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { InProcessOrchestratorClient } from '$client/impl/in-process.client.js';
import { TestDataFactory, createTestOrchestrator } from '../utils/test-helpers.js';
import type { ConversationEvent } from '$lib/types.js';

let orchestrator: ConversationOrchestrator;
let client: InProcessOrchestratorClient;
let conversationId: string;
let agentToken: string;

beforeEach(async () => {
  orchestrator = createTestOrchestrator();
  client = new InProcessOrchestratorClient(orchestrator);
  
  // Create a test conversation
  const { conversation, agentTokens } = await orchestrator.createConversation({
    metadata: { conversationTitle: "In-Process Query Tests" },
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

test('should create user queries via orchestrator', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const queryId = await client.createUserQuery('What is the weather today?');
  
  expect(queryId).toBeDefined();
  expect(typeof queryId).toBe('string');
  expect(queryId.length).toBeGreaterThan(0);
});

test('should return query IDs immediately', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const startTime = Date.now();
  const queryId = await client.createUserQuery('Quick query');
  const endTime = Date.now();
  
  expect(queryId).toBeDefined();
  expect(endTime - startTime).toBeLessThan(100); // Should be very fast
});

test('should validate query parameters', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Test with additional context
  const queryId = await client.createUserQuery(
    'What should I do next?', 
    { context: 'user_workflow', priority: 'high' },
    30000 // 30 second timeout
  );
  
  expect(queryId).toBeDefined();
});

test('should handle query creation errors', async () => {
  await client.connect();
  // Don't authenticate
  
  let error: any;
  try {
    await client.createUserQuery('This should fail');
  } catch (e) {
    error = e;
  }
  
  expect(error).toBeDefined();
  expect(error.message).toContain('not authenticated');
});

test('should accept query responses through orchestrator', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const queryId = await client.createUserQuery('Test query for response');
  
  // Respond to the query
  await client.respondToUserQuery(queryId, 'This is my response');
  
  // No error should be thrown
  expect(true).toBe(true);
});

test('should validate query IDs and permissions', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Try to respond to non-existent query
  let error: any;
  try {
    await client.respondToUserQuery('invalid-query-id', 'Response');
  } catch (e) {
    error = e;
  }
  
  expect(error).toBeDefined();
});

test('should emit proper events for query lifecycle', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const events: ConversationEvent[] = [];
  
  client.on('event', (event: ConversationEvent, subscriptionId: string) => {
    events.push(event);
  });
  
  const subscriptionId = await client.subscribe(conversationId);
  
  // Create a query
  const queryId = await client.createUserQuery('Event test query');
  
  // Wait for events
  await new Promise(resolve => setTimeout(resolve, 50));
  
  // Should receive user_query_created event
  const queryCreatedEvents = events.filter(e => e.type === 'user_query_created');
  expect(queryCreatedEvents.length).toBeGreaterThan(0);
  
  const queryEvent = queryCreatedEvents[0];
  expect(queryEvent.data.query.queryId).toBe(queryId);
  expect(queryEvent.data.query.question).toBe('Event test query');
});

test('should handle query timeouts appropriately', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Create query with very short timeout
  const queryId = await client.createUserQuery(
    'Quick timeout test',
    {},
    1 // 1ms timeout
  );
  
  // Wait longer than timeout
  await new Promise(resolve => setTimeout(resolve, 10));
  
  // Query should still exist (timeout handling is in orchestrator)
  expect(queryId).toBeDefined();
});

test('should handle multiple pending queries per agent', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Create multiple queries concurrently
  const queryIds = await Promise.all([
    client.createUserQuery('Query 1'),
    client.createUserQuery('Query 2'),
    client.createUserQuery('Query 3')
  ]);
  
  // All should be unique
  expect(queryIds[0]).not.toBe(queryIds[1]);
  expect(queryIds[0]).not.toBe(queryIds[2]);
  expect(queryIds[1]).not.toBe(queryIds[2]);
  
  // Respond to them in different order
  await Promise.all([
    client.respondToUserQuery(queryIds[1], 'Response to query 2'),
    client.respondToUserQuery(queryIds[0], 'Response to query 1'),
    client.respondToUserQuery(queryIds[2], 'Response to query 3')
  ]);
  
  // All responses should succeed
  expect(true).toBe(true);
});

test('should handle query workflow without authentication', async () => {
  await client.connect();
  // Don't authenticate
  
  let createError: any;
  try {
    await client.createUserQuery('Unauthenticated query');
  } catch (e) {
    createError = e;
  }
  
  expect(createError).toBeDefined();
  expect(createError.message).toContain('not authenticated');
});

test('should handle complex query context', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const complexContext = {
    userAgent: 'test-browser',
    sessionId: 'session-123',
    previousQueries: ['What is X?', 'How does Y work?'],
    metadata: {
      timestamp: new Date().toISOString(),
      priority: 'high',
      category: 'technical'
    }
  };
  
  const queryId = await client.createUserQuery(
    'Complex context query',
    complexContext,
    60000
  );
  
  expect(queryId).toBeDefined();
});

test('should track query response workflow', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const events: ConversationEvent[] = [];
  
  client.on('event', (event: ConversationEvent, subscriptionId: string) => {
    if (event.type === 'user_query_created' || event.type === 'user_query_answered') {
      events.push(event);
    }
  });
  
  const subscriptionId = await client.subscribe(conversationId);
  
  // Create and respond to query
  const queryId = await client.createUserQuery('Workflow test');
  await new Promise(resolve => setTimeout(resolve, 50));
  
  await client.respondToUserQuery(queryId, 'Workflow response');
  await new Promise(resolve => setTimeout(resolve, 50));
  
  // Should have both creation and response events
  const createdEvents = events.filter(e => e.type === 'user_query_created');
  const answeredEvents = events.filter(e => e.type === 'user_query_answered');
  
  expect(createdEvents.length).toBe(1);
  expect(answeredEvents.length).toBe(1);
  expect(createdEvents[0].data.query.queryId).toBe(queryId);
  expect(answeredEvents[0].data.queryId).toBe(queryId);
});