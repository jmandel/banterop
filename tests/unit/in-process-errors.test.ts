// In-Process Error Handling Tests

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { InProcessOrchestratorClient } from '$client/impl/in-process.client.js';
import { TestDataFactory, createTestOrchestrator } from '../utils/test-helpers.js';
import type { ThoughtEntry, ToolCallEntry, ToolResultEntry } from '$lib/types.js';

let orchestrator: ConversationOrchestrator;
let client: InProcessOrchestratorClient;
let conversationId: string;
let agentToken: string;

beforeEach(async () => {
  orchestrator = createTestOrchestrator();
  client = new InProcessOrchestratorClient(orchestrator);
  
  // Create a test conversation
  const { conversation, agentTokens } = await orchestrator.createConversation({
    name: 'In-Process Error Tests',
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

test('should handle orchestrator method failures gracefully', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Try to complete a non-existent turn
  let error: any;
  try {
    await client.completeTurn('invalid-turn-id', 'content');
  } catch (e) {
    error = e;
  }
  
  expect(error).toBeDefined();
  expect(error.message).toBeDefined();
  
  // Client should still be usable after error
  const subscriptionId = await client.subscribe(conversationId);
  expect(subscriptionId).toBeDefined();
});

test('should propagate appropriate error messages', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Test various error scenarios
  const errorTests = [
    {
      operation: () => client.completeTurn('invalid-turn-id', 'content'),
      expectedMessageContains: 'not found'
    },
    {
      operation: () => client.addTrace('invalid-turn-id', { type: 'thought', content: 'test' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>),
      expectedMessageContains: 'FOREIGN KEY constraint failed'
    },
    {
      operation: () => client.respondToUserQuery('invalid-query-id', 'response'),
      expectedMessageContains: 'not found'
    }
  ];
  
  for (const { operation, expectedMessageContains } of errorTests) {
    let error: any;
    try {
      await operation();
    } catch (e) {
      error = e;
    }
    
    expect(error).toBeDefined();
    expect(error.message.toLowerCase()).toContain(expectedMessageContains.toLowerCase());
  }
});

test('should maintain client state consistency during errors', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Create subscription before errors
  const subscriptionId = await client.subscribe(conversationId);
  
  // Cause multiple errors
  const errorOperations = [
    () => client.completeTurn('invalid-1', 'content'),
    () => client.addTrace('invalid-2', { type: 'thought', content: 'test' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>),
    () => client.respondToUserQuery('invalid-3', 'response')
  ];
  
  for (const operation of errorOperations) {
    try {
      await operation();
    } catch (e) {
      // Expected errors
    }
  }
  
  // Client should still work normally
  const turnId = await client.startTurn();
  expect(turnId).toBeDefined();
  
  const completedTurn = await client.completeTurn(turnId, 'Success after errors');
  expect(completedTurn.content).toBe('Success after errors');
});

test('should not crash on orchestrator exceptions', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Force various error conditions
  try {
    await client.completeTurn('', 'empty turn id');
  } catch (e) {
    // Expected
  }
  
  try {
    await client.addTrace('', { type: 'thought', content: 'empty turn id' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>);
  } catch (e) {
    // Expected
  }
  
  // Client should remain functional
  const queryId = await client.createUserQuery('Test after exceptions');
  expect(queryId).toBeDefined();
});

test('should validate all method parameters', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Test parameter validation for different methods
  const parameterTests = [
    {
      method: 'completeTurn',
      operation: () => client.completeTurn('', 'content'),
      expectedError: 'Turn  not found'
    }
  ];
  
  for (const { method, operation, expectedError } of parameterTests) {
    let error: any;
    try {
      await operation();
    } catch (e) {
      error = e;
    }
    
    expect(error).toBeDefined();
    expect(error.message).toContain(expectedError);
  }
});

test('should reject invalid or missing parameters', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Test missing parameters
  let error: any;
  
  try {
    // @ts-ignore - intentionally passing undefined
    await client.completeTurn(undefined, 'content');
  } catch (e) {
    error = e;
  }
  
  expect(error).toBeDefined();
});

test('should provide meaningful error messages', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Test that error messages are helpful
  const meaningfulErrors = [
    {
      operation: () => client.completeTurn('non-existent-turn', 'content'),
      shouldContain: ['not found', 'turn']
    },
    {
      operation: () => client.respondToUserQuery('non-existent-query', 'response'),
      shouldContain: ['not found', 'query']
    }
  ];
  
  for (const { operation, shouldContain } of meaningfulErrors) {
    let error: any;
    try {
      await operation();
    } catch (e) {
      error = e;
    }
    
    expect(error).toBeDefined();
    expect(error.message).toBeDefined();
    
    const errorMessage = error.message.toLowerCase();
    shouldContain.forEach(term => {
      expect(errorMessage).toContain(term.toLowerCase());
    });
  }
});

test('should handle edge cases appropriately', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Test edge cases
  const edgeCases = [
    {
      name: 'Empty string parameters',
      operation: () => client.completeTurn('', ''),
    },
    {
      name: 'Very long string parameters',
      operation: () => client.completeTurn('a'.repeat(1000), 'b'.repeat(10000)),
    },
    {
      name: 'Special characters in parameters',
      operation: () => client.completeTurn('special-chars-!@#$%^&*()', 'content with 特殊字符'),
    }
  ];
  
  for (const { name, operation } of edgeCases) {
    let error: any;
    try {
      await operation();
    } catch (e) {
      error = e;
    }
    
    // Should either succeed or fail gracefully with meaningful error
    if (error) {
      expect(error.message).toBeDefined();
      expect(error.message.length).toBeGreaterThan(0);
    }
  }
});

test('should handle connection state errors', async () => {
  // Test operations without connection
  let connectError: any;
  try {
    await client.authenticate(agentToken);
  } catch (e) {
    connectError = e;
  }
  
  expect(connectError).toBeDefined();
  expect(connectError.message).toContain('not connected');
  
  // Test operations without authentication
  await client.connect();
  
  let authError: any;
  try {
    await client.startTurn();
  } catch (e) {
    authError = e;
  }
  
  expect(authError).toBeDefined();
  expect(authError.message).toContain('not authenticated');
});

test('should handle authentication errors', async () => {
  await client.connect();
  
  // Test invalid token
  let invalidTokenError: any;
  try {
    await client.authenticate('invalid-token-123');
  } catch (e) {
    invalidTokenError = e;
  }
  
  expect(invalidTokenError).toBeDefined();
  expect(invalidTokenError.message).toContain('Invalid token');
  
  // Test empty token
  let emptyTokenError: any;
  try {
    await client.authenticate('');
  } catch (e) {
    emptyTokenError = e;
  }
  
  expect(emptyTokenError).toBeDefined();
  expect(emptyTokenError.message).toContain('Invalid token');
});

test('should handle subscription errors gracefully', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Subscribe to invalid conversation should still work (no validation)
  const subscriptionId = await client.subscribe('invalid-conversation');
  expect(subscriptionId).toBeDefined();
  
  // Unsubscribe with invalid ID should not crash
  await client.unsubscribe('invalid-subscription-id');
  expect(true).toBe(true); // Should not throw
});

test('should recover from error conditions', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Cause an error
  try {
    await client.completeTurn('invalid-turn', 'content');
  } catch (e) {
    // Expected error
  }
  
  // Should be able to perform normal operations after error
  const turnId = await client.startTurn();
  await client.addTrace(turnId, { type: 'thought', content: 'Recovery test' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>);
  const completedTurn = await client.completeTurn(turnId, 'Recovered successfully');
  
  expect(completedTurn.content).toBe('Recovered successfully');
  expect(completedTurn.trace).toHaveLength(1);
  expect((completedTurn.trace[0] as ThoughtEntry).content).toBe('Recovery test');
});

test('should handle concurrent operations with errors', async () => {
  await client.connect();
  await client.authenticate(agentToken);
  
  // Mix valid and invalid operations
  const operations = [
    client.startTurn(),
    client.completeTurn('invalid-turn-1', 'content').catch(e => null),
    client.createUserQuery('Valid query'),
    client.respondToUserQuery('invalid-query', 'response').catch(e => null),
    client.subscribe(conversationId)
  ];
  
  const results = await Promise.allSettled(operations);
  
  // Valid operations should succeed
  expect(results[0].status).toBe('fulfilled');
  expect(results[2].status).toBe('fulfilled');
  expect(results[4].status).toBe('fulfilled');
  
  // Invalid operations should be handled gracefully
  expect(results[1].status).toBe('fulfilled'); // Caught error, returned null
  expect(results[3].status).toBe('fulfilled'); // Caught error, returned null
});