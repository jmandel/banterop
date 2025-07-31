// In-Process Subscription Management Tests

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { InProcessTestClient, TestDataFactory, createTestOrchestrator } from '../utils/test-helpers.js';
import type { ConversationEvent } from '$lib/types.js';

let orchestrator: ConversationOrchestrator;
let client: InProcessTestClient;
let conversationId: string;
let agentToken: string;

beforeEach(async () => {
  orchestrator = createTestOrchestrator();
  client = new InProcessTestClient(orchestrator);
  
  // Create a test conversation
  const { conversation, agentTokens } = await orchestrator.createConversation({
    name: 'In-Process Subscription Tests',
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

test('should subscribe to conversation events directly', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const subscriptionId = await client.subscribe(conversationId);
  
  expect(subscriptionId).toBeDefined();
  expect(typeof subscriptionId).toBe('string');
  expect(subscriptionId.length).toBeGreaterThan(0);
});

test('should receive subscription IDs for tracking', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const subscriptionId1 = await client.subscribe(conversationId);
  const subscriptionId2 = await client.subscribe(conversationId);
  
  expect(subscriptionId1).toBeDefined();
  expect(subscriptionId2).toBeDefined();
  expect(subscriptionId1).not.toBe(subscriptionId2);
});

test('should handle subscription errors gracefully', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Test subscribing to non-existent conversation
  const invalidConversationId = 'invalid-conversation-id';
  
  // This should succeed (orchestrator doesn't validate conversation existence during subscription)
  const subscriptionId = await client.subscribe(invalidConversationId);
  expect(subscriptionId).toBeDefined();
});

test('should validate subscription parameters', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Test subscription with event filtering options
  const subscriptionId = await client.subscribe(conversationId, {
    events: ['turn_completed'],
    agents: [client.agentId!] // Access agent ID
  });
  
  expect(subscriptionId).toBeDefined();
});

test('should filter events by conversation ID', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const events: ConversationEvent[] = [];
  
  client.on('event', (event: ConversationEvent, subscriptionId: string) => {
    events.push(event);
  });
  
  const subscriptionId = await client.subscribe(conversationId);
  
  // Submit a turn to generate events
  await client.submitTurn('Test turn for filtering', []);
  
  // Wait a bit for events to be processed
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // All received events should be for the subscribed conversation
  events.forEach(event => {
    expect(event.conversationId).toBe(conversationId);
  });
  
  expect(events.length).toBeGreaterThan(0);
});

test('should filter events by agent ID when specified', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const events: ConversationEvent[] = [];
  const targetAgentId = client.agentId!; // Access agent ID
  
  client.on('event', (event: ConversationEvent, subscriptionId: string) => {
    events.push(event);
  });
  
  // Subscribe with agent filter
  const subscriptionId = await client.subscribe(conversationId, {
    agents: [targetAgentId]
  });
  
  // Submit a turn to generate events
  await client.submitTurn('Test turn for agent filtering', []);
  
  // Wait a bit for events to be processed
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // All received events should be from the specified agent (where applicable)
  events.forEach(event => {
    // Check agentId based on event type structure
    let eventAgentId: string | null = null;
    if (event.type === 'turn_started' && 'agentId' in event.data) {
      eventAgentId = event.data.agentId;
    } else if (event.type === 'turn_completed' && 'turn' in event.data) {
      eventAgentId = event.data.turn?.agentId;
    }
    
    if (eventAgentId) {
      expect(eventAgentId).toBe(targetAgentId);
    }
  });
  
  expect(events.length).toBeGreaterThan(0);
});

test('should filter events by event type when specified', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const events: ConversationEvent[] = [];
  
  client.on('event', (event: ConversationEvent, subscriptionId: string) => {
    events.push(event);
  });
  
  // Subscribe only to turn_completed events
  const subscriptionId = await client.subscribe(conversationId, {
    events: ['turn_completed']
  });
  
  // Submit a turn to generate multiple event types
  await client.submitTurn('Test turn for event filtering', []);
  
  // Wait a bit for events to be processed
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // All received events should be turn_completed events
  events.forEach(event => {
    expect(event.type).toBe('turn_completed');
  });
  
  expect(events.length).toBeGreaterThan(0);
});

test('should deliver events immediately without network delay', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const events: ConversationEvent[] = [];
  const eventTimestamps: number[] = [];
  
  client.on('event', (event: ConversationEvent, subscriptionId: string) => {
    events.push(event);
    eventTimestamps.push(Date.now());
  });
  
  const subscriptionId = await client.subscribe(conversationId);
  
  const startTime = Date.now();
  await client.submitTurn('Test immediate delivery', []);
  
  // Wait a bit for events to be processed
  await new Promise(resolve => setTimeout(resolve, 50));
  
  // Events should be delivered very quickly (in-process has no network delay)
  eventTimestamps.forEach(timestamp => {
    const delay = timestamp - startTime;
    expect(delay).toBeLessThan(100); // Should be very fast
  });
  
  expect(events.length).toBeGreaterThan(0);
});

test('should unsubscribe from events properly', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const events: ConversationEvent[] = [];
  
  client.on('event', (event: ConversationEvent, subscriptionId: string) => {
    events.push(event);
  });
  
  const subscriptionId = await client.subscribe(conversationId);
  
  // Generate some events
  await client.submitTurn('Before unsubscribe', []);
  
  // Wait for events
  await new Promise(resolve => setTimeout(resolve, 50));
  const eventsBeforeUnsubscribe = events.length;
  
  // Unsubscribe
  await client.unsubscribe(subscriptionId);
  
  // Generate more events
  await client.submitTurn('After unsubscribe', []);
  
  // Wait for potential events
  await new Promise(resolve => setTimeout(resolve, 50));
  
  // No new events should be received after unsubscribe
  expect(events.length).toBe(eventsBeforeUnsubscribe);
});

test('should clean up all subscriptions on disconnect', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const events: ConversationEvent[] = [];
  
  client.on('event', (event: ConversationEvent, subscriptionId: string) => {
    events.push(event);
  });
  
  // Create multiple subscriptions
  const sub1 = await client.subscribe(conversationId);
  const sub2 = await client.subscribe(conversationId);
  
  // Generate some events
  await client.submitTurn('Before disconnect', []);
  
  // Wait for events
  await new Promise(resolve => setTimeout(resolve, 50));
  const eventsBeforeDisconnect = events.length;
  expect(eventsBeforeDisconnect).toBeGreaterThan(0);
  
  // Disconnect (should clean up all subscriptions)
  await client.disconnect();
  
  // Try to generate more events (need to reconnect first)
  await client.connect();
  await client.authenticate(agentToken);
  await client.submitTurn('After disconnect', []);
  
  // Wait for potential events
  await new Promise(resolve => setTimeout(resolve, 50));
  
  // Should not receive new events (subscriptions were cleaned up)
  expect(events.length).toBe(eventsBeforeDisconnect);
});

test('should handle multiple subscriptions per client', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const allEvents: ConversationEvent[] = [];
  const turnEvents: ConversationEvent[] = [];
  
  client.on('event', (event: ConversationEvent, subscriptionId: string) => {
    allEvents.push(event);
  });
  
  // Create one subscription for all events
  const allEventsSubscription = await client.subscribe(conversationId);
  
  // Create another subscription for only turn events
  const turnEventsSubscription = await client.subscribe(conversationId, {
    events: ['turn_completed', 'turn_added']
  });
  
  // Add a separate handler to track turn events specifically
  client.on('event', (event: ConversationEvent, subscriptionId: string) => {
    if (subscriptionId === turnEventsSubscription && 
        event.type === 'turn_completed') {
      turnEvents.push(event);
    }
  });
  
  // Submit a turn to generate events
  await client.submitTurn('Multi-subscription test', []);
  
  // Wait for events
  await new Promise(resolve => setTimeout(resolve, 100));
  
  expect(allEvents.length).toBeGreaterThan(0);
  expect(turnEvents.length).toBeGreaterThan(0);
  expect(allEventsSubscription).not.toBe(turnEventsSubscription);
});

test('should prevent memory leaks from event listeners', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const initialListenerCount = client.listenerCount('event');
  
  // Add and remove event listeners multiple times
  for (let i = 0; i < 10; i++) {
    const handler = (event: ConversationEvent) => {};
    client.on('event', handler);
    client.off('event', handler);
  }
  
  const finalListenerCount = client.listenerCount('event');
  
  // Listener count should not have grown significantly
  expect(finalListenerCount).toBeLessThanOrEqual(initialListenerCount + 1);
});

test('should handle complex filter combinations', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const filteredEvents: ConversationEvent[] = [];
  const targetAgentId = client.agentId!;
  
  client.on('event', (event: ConversationEvent, subscriptionId: string) => {
    filteredEvents.push(event);
  });
  
  // Subscribe with multiple filters
  const subscriptionId = await client.subscribe(conversationId, {
    events: ['turn_completed'],
    agents: [targetAgentId]
  });
  
  // Submit a turn to generate events
  await client.submitTurn('Complex filter test', []);
  
  // Wait for events
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // All events should match both filters
  filteredEvents.forEach(event => {
    expect(event.type).toBe('turn_completed');
    // Check agentId for turn_completed events
    if ('turn' in event.data && event.data.turn?.agentId) {
      expect(event.data.turn.agentId).toBe(targetAgentId);
    }
  });
  
  expect(filteredEvents.length).toBeGreaterThan(0);
});

test('should not deliver events after unsubscription', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  const events: ConversationEvent[] = [];
  
  client.on('event', (event: ConversationEvent, subscriptionId: string) => {
    events.push(event);
  });
  
  const subscriptionId = await client.subscribe(conversationId);
  
  // Generate initial events
  await client.submitTurn('First turn', []);
  await new Promise(resolve => setTimeout(resolve, 50));
  
  const eventsAfterFirst = events.length;
  expect(eventsAfterFirst).toBeGreaterThan(0);
  
  // Unsubscribe
  await client.unsubscribe(subscriptionId);
  
  // Generate more events
  await client.submitTurn('Second turn', []);
  await new Promise(resolve => setTimeout(resolve, 50));
  
  // Should not have received new events
  expect(events.length).toBe(eventsAfterFirst);
});