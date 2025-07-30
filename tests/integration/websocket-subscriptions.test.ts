// WebSocket Event Subscription Tests

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { TestEnvironment, WebSocketTestClient, TestDataFactory, delay } from '../utils/test-helpers.js';

let testEnv: TestEnvironment;
let wsClient: WebSocketTestClient;
let conversationId: string;
let agentToken: string;

beforeEach(async () => {
  testEnv = new TestEnvironment();
  await testEnv.start();
  
  const { conversationId: cId, agents } = await testEnv.createTestConversation('Subscription Test');
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

test('should allow subscription to conversation events', async () => {
  const subscriptionId = await wsClient.subscribe(conversationId);
  
  expect(subscriptionId).toBeDefined();
  expect(typeof subscriptionId).toBe('string');
  expect(subscriptionId.length).toBeGreaterThan(0);
});

test('should return unique subscription IDs', async () => {
  const subscriptions = await Promise.all([
    wsClient.subscribe(conversationId),
    wsClient.subscribe(conversationId),
    wsClient.subscribe(conversationId)
  ]);

  expect(new Set(subscriptions).size).toBe(3); // All unique
});

test('should deliver turn_completed events immediately', async () => {
  await wsClient.subscribe(conversationId);
  wsClient.clearEvents();
  
  const startTime = Date.now();
  await wsClient.submitTurn('Immediate delivery test', []);
  
  // Wait specifically for turn_completed events with content validation
  const events = await wsClient.waitForSpecificEvents(
    (events) => {
      const hasCompleted = events.some(e => 
        e.type === 'turn_completed' && 
        e.data.turn.content === 'Immediate delivery test'
      );
      return hasCompleted;
    },
    1000,
    'turn_completed events with specific content'
  );
  
  const endTime = Date.now();
  
  const turnCompletedEvents = events.filter(e => e.type === 'turn_completed');
  expect(turnCompletedEvents).toHaveLength(1);
  expect(turnCompletedEvents[0].type).toBe('turn_completed');
  expect(turnCompletedEvents[0].data.turn.content).toBe('Immediate delivery test');
  
  // Should be delivered within reasonable time (less than 500ms)
  const deliveryTime = endTime - startTime;
  expect(deliveryTime).toBeLessThan(500);
});

test('should deliver turn_started events for streaming turns', async () => {
  await wsClient.subscribe(conversationId);
  wsClient.clearEvents();
  
  await wsClient.startTurn({ streaming_event_test: true });
  
  // Wait specifically for turn_started event with content validation
  const events = await wsClient.waitForSpecificEvents(
    (events) => events.some(e => 
      e.type === 'turn_started' && 
      e.data.turn?.agentId === 'test-agent-0'
    ),
    1000,
    'turn_started event from test-agent-0'
  );
  
  const turnStartedEvent = events.find(e => e.type === 'turn_started');
  expect(turnStartedEvent).toBeDefined();
  expect(turnStartedEvent!.type).toBe('turn_started');
  expect(turnStartedEvent!.data.turn.agentId).toBe('test-agent-0');
});

test('should deliver trace_added events during turn execution', async () => {
  await wsClient.subscribe(conversationId);
  wsClient.clearEvents();
  
  const turnId = await wsClient.startTurn({ trace_events: true });
  await wsClient.addTrace(turnId, TestDataFactory.createTraceEntryPartial('thought', 'Real-time trace'));
  
  // Wait specifically for both turn_started AND trace_added events
  const events = await wsClient.waitForSpecificEvents(
    (events) => {
      const hasTurnStarted = events.some(e => e.type === 'turn_started');
      const hasTraceAdded = events.some(e => 
        e.type === 'trace_added' && 
        e.data.trace.content === 'Real-time trace'
      );
      return hasTurnStarted && hasTraceAdded;
    },
    1000,
    'turn_started and trace_added events with specific content'
  );
  
  const traceEvents = events.filter(e => e.type === 'trace_added');
  expect(traceEvents).toHaveLength(1);
  expect(traceEvents[0].data.trace.content).toBe('Real-time trace');
});

test('should allow unsubscription with proper cleanup', async () => {
  const subscriptionId = await wsClient.subscribe(conversationId);
  
  // Verify we can unsubscribe
  await wsClient.unsubscribe(subscriptionId);
  
  // Submit a turn to generate events
  await wsClient.submitTurn('Post-unsubscribe turn', []);
  
  // Wait a bit to see if any events come through
  await delay(500);
  
  // Should not have received events after unsubscription
  const events = wsClient.getEvents();
  const postUnsubscribeEvents = events.filter(e => e.type === 'turn_completed');
  expect(postUnsubscribeEvents).toHaveLength(0);
});