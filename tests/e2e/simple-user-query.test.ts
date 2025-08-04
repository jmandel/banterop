/**
 * Simple E2E Test: Basic User Query Flow
 */

import { test, expect } from 'bun:test';
import { TestEnvironment } from '../utils/test-helpers.js';
import type { SequentialScriptConfig } from '$lib/types.js';

test('basic user query creation and response flow', async () => {
  const testEnv = new TestEnvironment();
  await testEnv.start();
  
  // Define simple agent that creates a user query
  const agentConfig: SequentialScriptConfig = {
    id: "test-agent",
    strategyType: 'sequential_script',
    script: [
      {
        trigger: { type: 'conversation_ready' },
        steps: [
          { 
            type: 'user_query', 
            question: 'What is the current time?',
            context: { test: 'basic' }
          }
        ]
      }
    ]
  };
  
  // Create conversation
  const response = await fetch(`${testEnv.httpUrl}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metadata: { conversationTitle: "Simple User Query Test" },
      agents: [agentConfig],
      /* managementMode removed */
    })
  });
  
  expect(response.ok).toBe(true);
  const result = await response.json();
  expect(result.conversation.id).toBeDefined();
  
  // Start the conversation to activate agents
  const startResponse = await fetch(`${testEnv.httpUrl}/conversations/${result.conversation.id}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  
  if (!startResponse.ok) {
    const errorText = await startResponse.text();
    console.error(`Start response failed: ${startResponse.status} - ${errorText}`);
    throw new Error(`Failed to start conversation: ${startResponse.status} - ${errorText}`);
  }
  
  // Wait for agent to create query
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Check for pending queries
  const queryResponse = await fetch(`${testEnv.httpUrl}/queries/pending`);
  expect(queryResponse.ok).toBe(true);
  
  const queries = await queryResponse.json();
  expect(queries.count).toBe(1);
  expect(queries.queries[0].question).toBe('What is the current time?');
  expect(queries.queries[0].context.test).toBe('basic');
  expect(queries.queries[0].status).toBe('pending');
  
  // Respond to the query
  const queryId = queries.queries[0].queryId;
  const respondResponse = await fetch(`${testEnv.httpUrl}/queries/${queryId}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response: '2:30 PM' })
  });
  
  expect(respondResponse.ok).toBe(true);
  
  // Verify query is no longer pending
  const afterResponse = await fetch(`${testEnv.httpUrl}/queries/pending`);
  const afterQueries = await afterResponse.json();
  expect(afterQueries.count).toBe(0);
  
  await testEnv.stop();
}, 10000);