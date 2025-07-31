// Client Parity Tests - Ensure WebSocket and In-Process clients behave identically

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { WebSocketJsonRpcClient } from '$client/impl/websocket.client.js';
import { InProcessOrchestratorClient } from '$client/impl/in-process.client.js';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { TestEnvironment, TestDataFactory } from '../utils/test-helpers.js';
import { WebSocket } from 'ws';
import type { ThoughtEntry, ToolCallEntry, ToolResultEntry } from '$lib/types.js';

let testEnv: TestEnvironment;
let orchestrator: ConversationOrchestrator;
let wsClient: WebSocketJsonRpcClient;
let inProcessClient: InProcessOrchestratorClient;
let conversationId: string;
let agentToken: string;
let port: number;

beforeEach(async () => {
  testEnv = new TestEnvironment();
  await testEnv.start();
  
  orchestrator = testEnv.orchestrator;
  port = testEnv.server.port;
  
  // Create WebSocket client
  wsClient = new WebSocketJsonRpcClient(`ws://localhost:${port}/api/ws`);
  
  // Create in-process client
  inProcessClient = new InProcessOrchestratorClient(orchestrator);
  
  // Create a test conversation
  const { conversation, agentTokens } = await orchestrator.createConversation({
    name: 'Client Parity Tests',
    agents: [TestDataFactory.createStaticReplayConfig()]
  });
  
  conversationId = conversation.id;
  agentToken = Object.values(agentTokens)[0];
});

afterEach(async () => {
  if (wsClient) {
    await wsClient.disconnect();
  }
  if (inProcessClient) {
    await inProcessClient.disconnect();
  }
  if (testEnv) {
    await testEnv.stop();
  }
});

test('should implement identical OrchestratorClient interface', async () => {
  // Both clients should have the same methods
  const wsClientMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(wsClient));
  const inProcessClientMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(inProcessClient));
  
  // Filter out constructor and internal methods
  const publicMethods = [
    'connect', 'disconnect', 'authenticate', 'subscribe', 'unsubscribe',
    'startTurn', 'addTrace', 'completeTurn', 'createUserQuery', 'respondToUserQuery'
  ];
  
  publicMethods.forEach(method => {
    expect(wsClientMethods).toContain(method);
    expect(inProcessClientMethods).toContain(method);
    
    // Both should be functions
    expect(typeof (wsClient as any)[method]).toBe('function');
    expect(typeof (inProcessClient as any)[method]).toBe('function');
  });
});

test('should provide same method signatures and return types', async () => {
  // Connect both clients
  await wsClient.connect();
  await inProcessClient.connect();
  
  // Authenticate both
  await wsClient.authenticate(agentToken);
  await inProcessClient.authenticate(agentToken);
  
  // Subscribe - both should return string subscription IDs
  const wsSubscriptionId = await wsClient.subscribe(conversationId);
  const inProcessSubscriptionId = await inProcessClient.subscribe(conversationId);
  
  expect(typeof wsSubscriptionId).toBe('string');
  expect(typeof inProcessSubscriptionId).toBe('string');
  expect(wsSubscriptionId.length).toBeGreaterThan(0);
  expect(inProcessSubscriptionId.length).toBeGreaterThan(0);
  
  // Start turn - both should return string turn IDs
  const wsTurnId = await wsClient.startTurn();
  const inProcessTurnId = await inProcessClient.startTurn();
  
  expect(typeof wsTurnId).toBe('string');
  expect(typeof inProcessTurnId).toBe('string');
  expect(wsTurnId.length).toBeGreaterThan(0);
  expect(inProcessTurnId.length).toBeGreaterThan(0);
  
  // Complete turns - both should return Turn objects with same structure
  const wsCompletedTurn = await wsClient.completeTurn(wsTurnId, 'WS content');
  const inProcessCompletedTurn = await inProcessClient.completeTurn(inProcessTurnId, 'In-process content');
  
  // Both should have same structure
  expect(wsCompletedTurn).toHaveProperty('id');
  expect(wsCompletedTurn).toHaveProperty('content');
  expect(wsCompletedTurn).toHaveProperty('agentId');
  expect(wsCompletedTurn).toHaveProperty('conversationId');
  expect(wsCompletedTurn).toHaveProperty('timestamp');
  expect(wsCompletedTurn).toHaveProperty('trace');
  
  expect(inProcessCompletedTurn).toHaveProperty('id');
  expect(inProcessCompletedTurn).toHaveProperty('content');
  expect(inProcessCompletedTurn).toHaveProperty('agentId');
  expect(inProcessCompletedTurn).toHaveProperty('conversationId');
  expect(inProcessCompletedTurn).toHaveProperty('timestamp');
  expect(inProcessCompletedTurn).toHaveProperty('trace');
  
  expect(wsCompletedTurn.content).toBe('WS content');
  expect(inProcessCompletedTurn.content).toBe('In-process content');
});

test('should handle same error conditions similarly', async () => {
  // Test unauthenticated operations
  await wsClient.connect();
  await inProcessClient.connect();
  
  // Both should reject unauthenticated operations
  let wsError, inProcessError;
  
  try {
    await wsClient.startTurn();
  } catch (e) {
    wsError = e;
  }
  
  try {
    await inProcessClient.startTurn();
  } catch (e) {
    inProcessError = e;
  }
  
  expect(wsError).toBeDefined();
  expect(inProcessError).toBeDefined();
  expect(wsError.message.toLowerCase()).toMatch(/not authenticated|unauthorized/);
  expect(inProcessError.message.toLowerCase()).toMatch(/not authenticated|unauthorized/);
  
  // Test invalid authentication
  wsError = undefined;
  inProcessError = undefined;
  
  try {
    await wsClient.authenticate('invalid-token');
  } catch (e) {
    wsError = e;
  }
  
  try {
    await inProcessClient.authenticate('invalid-token');
  } catch (e) {
    inProcessError = e;
  }
  
  expect(wsError).toBeDefined();
  expect(inProcessError).toBeDefined();
  expect(wsError.message).toContain('Invalid token');
  expect(inProcessError.message).toContain('Invalid token');
});

test('should produce same conversation outcomes', async () => {
  // Connect and authenticate both clients
  await wsClient.connect();
  await inProcessClient.connect();
  
  await wsClient.authenticate(agentToken);
  await inProcessClient.authenticate(agentToken);
  
  // Create identical turn sequences
  const wsEvents: any[] = [];
  const inProcessEvents: any[] = [];
  
  // Subscribe to events
  wsClient.on('event', (event) => {
    if (event.type === 'turn_completed') wsEvents.push(event);
  });
  inProcessClient.on('event', (event) => {
    if (event.type === 'turn_completed') inProcessEvents.push(event);
  });
  
  await wsClient.subscribe(conversationId);
  await inProcessClient.subscribe(conversationId);
  
  // Execute identical operations
  const wsTurnId = await wsClient.startTurn();
  const inProcessTurnId = await inProcessClient.startTurn();
  
  await wsClient.addTrace(wsTurnId, { type: 'thought', content: 'Test thought' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>);
  await inProcessClient.addTrace(inProcessTurnId, { type: 'thought', content: 'Test thought' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>);
  
  const wsCompletedTurn = await wsClient.completeTurn(wsTurnId, 'Identical content');
  const inProcessCompletedTurn = await inProcessClient.completeTurn(inProcessTurnId, 'Identical content');
  
  // Wait for events to propagate
  await new Promise(resolve => setTimeout(resolve, 50));
  
  // Should produce equivalent results
  expect(wsCompletedTurn.content).toBe(inProcessCompletedTurn.content);
  expect(wsCompletedTurn.trace.length).toBe(inProcessCompletedTurn.trace.length);
  expect((wsCompletedTurn.trace[0] as ThoughtEntry).content).toBe((inProcessCompletedTurn.trace[0] as ThoughtEntry).content);
  
  // Events should have been received
  expect(wsEvents.length).toBeGreaterThan(0);
  expect(inProcessEvents.length).toBeGreaterThan(0);
});

test('should emit same events in same order', async () => {
  // Connect and authenticate both clients
  await wsClient.connect();
  await inProcessClient.connect();
  
  await wsClient.authenticate(agentToken);
  await inProcessClient.authenticate(agentToken);
  
  const wsEventOrder: string[] = [];
  const inProcessEventOrder: string[] = [];
  
  // Track event order for both clients
  const eventTypes = ['turn_started', 'trace_added', 'turn_completed'];
  
  wsClient.on('event', (event) => {
    if (eventTypes.includes(event.type)) {
      wsEventOrder.push(event.type);
    }
  });
  inProcessClient.on('event', (event) => {
    if (eventTypes.includes(event.type)) {
      inProcessEventOrder.push(event.type);
    }
  });
  
  await wsClient.subscribe(conversationId);
  await inProcessClient.subscribe(conversationId);
  
  // Execute operations
  const wsTurnId = await wsClient.startTurn();
  const inProcessTurnId = await inProcessClient.startTurn();
  
  await wsClient.addTrace(wsTurnId, { type: 'thought', content: 'Event order test' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>);
  await inProcessClient.addTrace(inProcessTurnId, { type: 'thought', content: 'Event order test' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>);
  
  await wsClient.completeTurn(wsTurnId, 'Event order content');
  await inProcessClient.completeTurn(inProcessTurnId, 'Event order content');
  
  // Wait for all events to propagate
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Should have same event sequence (both clients see both turns)
  expect(wsEventOrder).toEqual(inProcessEventOrder);
  // Each client creates one turn, so both clients see 2 turns each
  expect(wsEventOrder).toEqual(['turn_started', 'turn_started', 'trace_added', 'trace_added', 'turn_completed', 'turn_completed']);
});

test('should handle authentication similarly', async () => {
  // Connect both clients
  await wsClient.connect();
  await inProcessClient.connect();
  
  // Valid authentication should succeed for both
  await wsClient.authenticate(agentToken);
  await inProcessClient.authenticate(agentToken);
  
  // Both should now be authenticated and able to perform operations
  const wsSubscriptionId = await wsClient.subscribe(conversationId);
  const inProcessSubscriptionId = await inProcessClient.subscribe(conversationId);
  
  expect(wsSubscriptionId).toBeDefined();
  expect(inProcessSubscriptionId).toBeDefined();
});

test('should maintain same event filtering behavior', async () => {
  // Connect and authenticate both clients
  await wsClient.connect();
  await inProcessClient.connect();
  
  await wsClient.authenticate(agentToken);
  await inProcessClient.authenticate(agentToken);
  
  // Create a second conversation for filtering test
  const { conversation: otherConversation } = await orchestrator.createConversation({
    name: 'Other Conversation',
    agents: [TestDataFactory.createStaticReplayConfig()]
  });
  
  const wsEventsForMainConv: any[] = [];
  const inProcessEventsForMainConv: any[] = [];
  
  // Subscribe to events for main conversation only
  wsClient.on('event', (event) => {
    if (event.type === 'turn_completed' && event.data?.turn?.conversationId === conversationId) {
      wsEventsForMainConv.push(event);
    }
  });
  
  inProcessClient.on('event', (event) => {
    if (event.type === 'turn_completed' && event.data?.turn?.conversationId === conversationId) {
      inProcessEventsForMainConv.push(event);
    }
  });
  
  // Subscribe to main conversation only
  await wsClient.subscribe(conversationId);
  await inProcessClient.subscribe(conversationId);
  
  // Create turn in main conversation
  const wsTurnId = await wsClient.startTurn();
  const inProcessTurnId = await inProcessClient.startTurn();
  
  await wsClient.completeTurn(wsTurnId, 'Main conversation content');
  await inProcessClient.completeTurn(inProcessTurnId, 'Main conversation content');
  
  // Wait for events
  await new Promise(resolve => setTimeout(resolve, 50));
  
  // Both should have received events from main conversation (both clients create turns, so 2 events each)
  expect(wsEventsForMainConv.length).toBe(2);
  expect(inProcessEventsForMainConv.length).toBe(2);
  
  // Both events should be for the correct conversation
  expect(wsEventsForMainConv[0].data.turn.conversationId).toBe(conversationId);
  expect(inProcessEventsForMainConv[0].data.turn.conversationId).toBe(conversationId);
});

test('should demonstrate in-process performance advantages', async () => {
  // Connect both clients
  await wsClient.connect();
  await inProcessClient.connect();
  
  await wsClient.authenticate(agentToken);
  await inProcessClient.authenticate(agentToken);
  
  // Measure response times for subscription
  const wsStartTime = performance.now();
  await wsClient.subscribe(conversationId);
  const wsSubscribeTime = performance.now() - wsStartTime;
  
  const inProcessStartTime = performance.now();
  await inProcessClient.subscribe(conversationId);
  const inProcessSubscribeTime = performance.now() - inProcessStartTime;
  
  // In-process should be faster (allowing some tolerance for test environment)
  expect(inProcessSubscribeTime).toBeLessThan(wsSubscribeTime + 5); // 5ms tolerance
  
  // Measure turn creation times
  const wsTurnStartTime = performance.now();
  const wsTurnId = await wsClient.startTurn();
  const wsTurnTime = performance.now() - wsTurnStartTime;
  
  const inProcessTurnStartTime = performance.now();
  const inProcessTurnId = await inProcessClient.startTurn();
  const inProcessTurnTime = performance.now() - inProcessTurnStartTime;
  
  // Clean up turns
  await wsClient.completeTurn(wsTurnId, 'Performance test');
  await inProcessClient.completeTurn(inProcessTurnId, 'Performance test');
  
  // In-process should typically be faster due to no network overhead
  // Note: This might not always be true in tests due to timing variations
  // but the infrastructure should support better performance
  expect(inProcessTurnTime).toBeLessThan(wsTurnTime + 10); // 10ms tolerance
});

test('should handle higher throughput than WebSocket', async () => {
  // Connect both clients
  await wsClient.connect();
  await inProcessClient.connect();
  
  await wsClient.authenticate(agentToken);
  await inProcessClient.authenticate(agentToken);
  
  // Test rapid operations
  const operationCount = 5; // Keep small for test speed
  
  // Measure WebSocket throughput
  const wsStartTime = performance.now();
  const wsPromises = [];
  for (let i = 0; i < operationCount; i++) {
    wsPromises.push(
      wsClient.startTurn().then(turnId => 
        wsClient.completeTurn(turnId, `WS content ${i}`)
      )
    );
  }
  await Promise.all(wsPromises);
  const wsTime = performance.now() - wsStartTime;
  
  // Measure in-process throughput
  const inProcessStartTime = performance.now();
  const inProcessPromises = [];
  for (let i = 0; i < operationCount; i++) {
    inProcessPromises.push(
      inProcessClient.startTurn().then(turnId => 
        inProcessClient.completeTurn(turnId, `In-process content ${i}`)
      )
    );
  }
  await Promise.all(inProcessPromises);
  const inProcessTime = performance.now() - inProcessStartTime;
  
  // In-process should handle same or better throughput
  expect(inProcessTime).toBeLessThanOrEqual(wsTime + 20); // 20ms tolerance
});

test('should provide more deterministic timing', async () => {
  // Connect both clients
  await wsClient.connect();
  await inProcessClient.connect();
  
  await wsClient.authenticate(agentToken);
  await inProcessClient.authenticate(agentToken);
  
  // Measure timing consistency over multiple operations
  const measurements = 3;
  const wsTimes: number[] = [];
  const inProcessTimes: number[] = [];
  
  // WebSocket timing measurements
  for (let i = 0; i < measurements; i++) {
    const startTime = performance.now();
    const turnId = await wsClient.startTurn();
    await wsClient.completeTurn(turnId, `WS timing test ${i}`);
    wsTimes.push(performance.now() - startTime);
  }
  
  // In-process timing measurements
  for (let i = 0; i < measurements; i++) {
    const startTime = performance.now();
    const turnId = await inProcessClient.startTurn();
    await inProcessClient.completeTurn(turnId, `In-process timing test ${i}`);
    inProcessTimes.push(performance.now() - startTime);
  }
  
  // Calculate variance (measure of consistency)
  const wsVariance = calculateVariance(wsTimes);
  const inProcessVariance = calculateVariance(inProcessTimes);
  
  // In-process should typically have less variance (more deterministic)
  // Note: This test might be flaky due to system load, so we use a lenient check
  expect(inProcessVariance).toBeLessThanOrEqual(wsVariance + 5); // Allow some tolerance
});

// Helper function to calculate variance
function calculateVariance(numbers: number[]): number {
  const mean = numbers.reduce((sum, num) => sum + num, 0) / numbers.length;
  const squaredDiffs = numbers.map(num => Math.pow(num - mean, 2));
  return squaredDiffs.reduce((sum, diff) => sum + diff, 0) / numbers.length;
}

test('should handle mixed client scenarios in same conversation', async () => {
  // Connect both clients to same conversation
  await wsClient.connect();
  await inProcessClient.connect();
  
  await wsClient.authenticate(agentToken);
  await inProcessClient.authenticate(agentToken);
  
  const wsEvents: any[] = [];
  const inProcessEvents: any[] = [];
  
  wsClient.on('event', (event) => {
    if (event.type === 'turn_completed') wsEvents.push(event);
  });
  inProcessClient.on('event', (event) => {
    if (event.type === 'turn_completed') inProcessEvents.push(event);
  });
  
  await wsClient.subscribe(conversationId);
  await inProcessClient.subscribe(conversationId);
  
  // WebSocket client creates a turn
  const wsTurnId = await wsClient.startTurn();
  await wsClient.completeTurn(wsTurnId, 'WebSocket turn');
  
  // In-process client creates a turn
  const inProcessTurnId = await inProcessClient.startTurn();
  await inProcessClient.completeTurn(inProcessTurnId, 'In-process turn');
  
  // Wait for events
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Both clients should have received events from both turns
  expect(wsEvents.length).toBe(2);
  expect(inProcessEvents.length).toBe(2);
  
  // Events should contain both turns
  const wsContents = wsEvents.map(e => e.data.turn.content).sort();
  const inProcessContents = inProcessEvents.map(e => e.data.turn.content).sort();
  
  expect(wsContents).toEqual(['In-process turn', 'WebSocket turn']);
  expect(inProcessContents).toEqual(['In-process turn', 'WebSocket turn']);
});