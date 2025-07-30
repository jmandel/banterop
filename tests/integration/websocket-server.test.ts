// WebSocket Server Integration Tests

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { TestEnvironment, WebSocketTestClient, TEST_CONFIG } from '../utils/test-helpers.js';

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

test('WebSocket server should start on specified port', async () => {
  expect(testEnv.server).toBeDefined();
  expect(testEnv.server.port).toBeGreaterThan(0);
  expect(testEnv.wsUrl).toContain(`localhost:${testEnv.server.port}`);
});

test('should accept WebSocket connections', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();

  expect(testEnv.wsServer.getConnectedClients()).toBe(1);
});

test('should handle JSON-RPC protocol correctly', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();

  // Test with a simple method call - should not crash
  let error: any;
  try {
    await wsClient.getConversation('test-id');
  } catch (e) {
    error = e;
  }

  // Even if it fails, it should be a proper JSON-RPC error
  if (error) {
    expect(error.code).toBeDefined();
  }
});

test('should handle multiple concurrent connections', async () => {
  const clients: WebSocketTestClient[] = [];
  
  // Create multiple clients
  for (let i = 0; i < 3; i++) {
    const client = new WebSocketTestClient(testEnv.wsUrl!);
    await client.connect();
    clients.push(client);
  }

  expect(testEnv.wsServer.getConnectedClients()).toBe(3);

  // Clean up
  for (const client of clients) {
    await client.disconnect();
  }
  
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(testEnv.wsServer.getConnectedClients()).toBe(0);
});

test('should clean up connections on disconnect', async () => {
  wsClient = new WebSocketTestClient(testEnv.wsUrl!);
  await wsClient.connect();

  expect(testEnv.wsServer.getConnectedClients()).toBe(1);

  await wsClient.disconnect();
  
  // Give time for server to process disconnect
  await new Promise(resolve => setTimeout(resolve, 100));
  
  expect(testEnv.wsServer.getConnectedClients()).toBe(0);
});
