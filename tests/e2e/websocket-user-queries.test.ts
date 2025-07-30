/**
 * Simple E2E test for WebSocket user query notifications
 * Tests that WebSocket clients get notified when user queries are created
 */

import { test, expect } from 'bun:test';
import { TestEnvironment } from '../utils/test-helpers.js';
import type { ConversationEvent } from '$lib/types.js';

test('WebSocket clients receive user_query_created events', async () => {
  const testEnv = new TestEnvironment();
  await testEnv.start();
  
  // First create conversation without starting agents
  const createResponse = await fetch(`${testEnv.httpUrl}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'WebSocket Query Test',
      agents: [{
        agentId: { id: 'test-agent', label: 'Test Agent', role: 'assistant' },
        strategyType: 'sequential_script',
        script: [{
          trigger: { type: 'message' },  // Use message trigger to control timing
          steps: [{ type: 'user_query', question: 'Test WebSocket notification', context: {} }]
        }]
      }]
    })
  });
  
  const { conversation, agentTokens } = await createResponse.json();
  const conversationId = conversation.id;
  const agentToken = Object.values(agentTokens)[0] as string;
  
  // Set up WebSocket client
  const { WebSocketJsonRpcClient } = await import('$client/impl/websocket.client.js');
  const { WebSocket } = await import('ws');
  const wsClient = new WebSocketJsonRpcClient(testEnv.wsUrl!, WebSocket);
  await wsClient.connect();
  await wsClient.authenticate(agentToken);
  await wsClient.subscribe(conversationId);
  
  // First, check existing pending queries via WebSocket
  const { queries: initialQueries } = await wsClient.getAllPendingUserQueries();
  console.log(`Initial pending queries: ${initialQueries.length}`);
  
  // Set up event listener for new queries
  const queryCreatedPromise = new Promise<ConversationEvent>((resolve) => {
    wsClient.on('event', (event: ConversationEvent) => {
      console.log(`WebSocket event: ${event.type}`);
      if (event.type === 'user_query_created') {
        resolve(event);
      }
    });
  });
  
  // Create a user query using the WebSocket client (same way agents do)
  const queryId = await wsClient.createUserQuery('Test WebSocket notification', {});
  
  // Wait for the WebSocket event
  const queryEvent = await queryCreatedPromise;
  
  // Verify the event data
  expect(queryEvent.data.query.question).toBe('Test WebSocket notification');
  expect(queryEvent.data.query.agentId).toBe('test-agent');
  expect(queryEvent.data.query.queryId).toBe(queryId);
  
  // Verify the query shows up in both WebSocket and HTTP APIs
  const { queries: wsQueries } = await wsClient.getAllPendingUserQueries();
  const wsMatchingQuery = wsQueries.find((q: any) => q.queryId === queryId);
  expect(wsMatchingQuery).toBeDefined();
  expect(wsMatchingQuery.question).toBe('Test WebSocket notification');
  
  const httpResponse = await fetch(`${testEnv.httpUrl}/queries/pending`);
  const { queries: httpQueries } = await httpResponse.json();
  const httpMatchingQuery = httpQueries.find((q: any) => q.queryId === queryId);
  expect(httpMatchingQuery).toBeDefined();
  expect(httpMatchingQuery.question).toBe('Test WebSocket notification');
  
  console.log('✅ WebSocket user query notification test passed - validated via both WebSocket and HTTP');
  
  // Cleanup
  wsClient.disconnect();
  await testEnv.stop();
}, 10000);