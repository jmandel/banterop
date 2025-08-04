/**
 * E2E Test: Multi-Agent Conversation with User Query Integration
 * Tests complete workflow between multiple agents with user interaction
 */

import type { ConversationEvent, SequentialScriptConfig } from '$lib/types.js';
import { CreateConversationResponse } from '$lib/types.js';
import { expect, test } from 'bun:test';
import { TestEnvironment } from '../utils/test-helpers.js';

test('multi-agent workflow with user queries and tool usage', async () => {
  const testEnv = new TestEnvironment();
  await testEnv.start();
  
  // Define scripted agents for the conversation
  const supportAgentConfig: SequentialScriptConfig = {
    id: "support-agent",
    strategyType: 'sequential_script',
    script: [
      {
        trigger: { type: 'conversation_ready' },
        steps: [
          { 
            type: 'thought', 
            content: 'Customer issue needs technical expertise and escalation' 
          },
          { 
            type: 'tool_call', 
            tool: { name: 'check_customer_account', params: { customer_id: 'cust-123' } } 
          },
          { 
            type: 'response', 
            content: 'I have a customer with database connection timeouts that needs specialist attention. The customer is experiencing significant delays during checkout.' 
          }
        ]
      }
    ]
  };
  
  const techAgentConfig: SequentialScriptConfig = {
    id: "tech-specialist",
    strategyType: 'sequential_script',
    script: [
      {
        trigger: { type: 'agent_turn', from: 'support-agent', contains: 'specialist attention' },
        steps: [
          { 
            type: 'thought', 
            content: 'I need to analyze this database timeout issue systematically' 
          },
          { 
            type: 'tool_call', 
            tool: { name: 'analyze_database_performance', params: { timeframe: '24h' } } 
          },
          { 
            type: 'tool_call', 
            tool: { name: 'run_connection_diagnostics', params: { timeout_threshold: 30 } } 
          },
          { 
            type: 'user_query', 
            question: 'When did the customer first notice these timeout issues? This will help me correlate with our performance data.',
            context: { stage: 'initial_analysis', issue_type: 'database_timeout' }
          }
        ]
      },
      {
        trigger: { type: 'user_query_answered', context: { stage: 'initial_analysis' } },
        steps: [
          { 
            type: 'tool_call', 
            tool: { name: 'generate_config_template', params: { pool_size: 20, timeout: 30000 } } 
          },
          { 
            type: 'user_query', 
            question: 'Should I proceed with implementing the connection pool configuration? It requires a brief maintenance window.',
            context: { stage: 'approval', estimated_downtime: '5-10 minutes', risk_level: 'low' }
          }
        ]
      },
      {
        trigger: { type: 'user_query_answered', context: { stage: 'approval' } },
        steps: [
          { 
            type: 'response', 
            content: 'Based on your timeline and approval, I\'ve diagnosed the issue. The database needs connection pooling to handle traffic spikes. I\'ve prepared the configuration and can implement it during the approved maintenance window.' 
          }
        ]
      }
    ]
  };
  
  // Create conversation
  const createResponse = await fetch(`${testEnv.httpUrl}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metadata: { conversationTitle: "Multi-Agent E2E Test" },
      agents: [supportAgentConfig, techAgentConfig],
      /* managementMode removed */
    })
  });
  
  const { conversation, agentTokens } = (await createResponse.json()) as CreateConversationResponse;
  const conversationId = conversation.id;
  
  // Start the conversation to activate agents
  const startResponse = await fetch(`${testEnv.httpUrl}/conversations/${conversationId}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  
  expect(startResponse.ok).toBe(true);
  
  // Set up WebSocket monitoring
  const { WebSocketJsonRpcClient } = await import('$client/impl/websocket.client.js');
  const { WebSocket } = await import('ws');
  const wsClient = new WebSocketJsonRpcClient(testEnv.wsUrl!);
  await wsClient.connect();
  
  const firstAgentToken = Object.values(agentTokens)[0] as string;
  await wsClient.authenticate(firstAgentToken);
  await wsClient.subscribe(conversationId);
  
  // Catch up on any queries that were created before we connected
  const { queries: initialQueries } = await wsClient.getAllPendingUserQueries();
  console.log(`Found ${initialQueries.length} pending queries when connecting`);
  
  // Collect events for validation
  const events: ConversationEvent[] = [];
  wsClient.on('event', (event: ConversationEvent) => {
    events.push(event);
    console.log(`Event: ${event.type}`);
  });
  
  // Set up automated query responder
  const queryResponses = new Map([
    ['when did the customer first notice', 'The customer first reported timeout issues on Tuesday morning around 9 AM, coinciding with increased traffic from a marketing campaign.'],
    ['should i proceed with implementing', 'Yes, proceed with the connection pool configuration. The customer has approved a 5-10 minute maintenance window for tonight at 2 AM.']
  ]);
  
  // Helper function to respond to a list of queries
  const respondToQueryList = async (queries: any[]) => {
    for (const query of queries) {
      const questionLower = query.question.toLowerCase();
      
      for (const [pattern, response] of queryResponses) {
        if (questionLower.includes(pattern)) {
          console.log(`Auto-responding to: "${query.question}"`);
          console.log(`Response: "${response}"`);
          
          await wsClient.respondToUserQuery(query.queryId, response);
          break;
        }
      }
    }
  };

  // First, respond to any queries found during initial catchup
  if (initialQueries.length > 0) {
    console.log(`Responding to ${initialQueries.length} initial queries`);
    await respondToQueryList(initialQueries);
  }

  // Monitor and respond to new queries
  const respondToQueries = async () => {
    while (true) {
      try {
        const { queries } = await wsClient.getAllPendingUserQueries();
        await respondToQueryList(queries);
        await new Promise(resolve => setTimeout(resolve, 10));
      } catch (error) {
        break; // Exit when test is done
      }
    }
  };
  
  // Start query monitoring
  const queryMonitoringPromise = respondToQueries();
  
  // Wait for key events in the conversation flow
  const waitForEvents = (eventTypes: string[], timeoutMs = 15000) => {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for events: ${eventTypes.join(', ')}`));
      }, timeoutMs);
      
      const checkEvents = () => {
        const hasAllEvents = eventTypes.every(type => 
          events.some(e => e.type === type)
        );
        
        if (hasAllEvents) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkEvents, 10);
        }
      };
      
      checkEvents();
    });
  };
  
  // Wait for the complete conversation flow
  await waitForEvents([
    'turn_completed',        // Support agent completes escalation
    'user_query_created',    // Tech agent asks first question
    'user_query_answered',   // First question answered
    'user_query_created',    // Tech agent asks second question  
    'user_query_answered',   // Second question answered
    'turn_completed'         // Tech agent completes with solution
  ], 5000);
  
  // Validate the conversation flow - now we can be more strict since we catch up on missed events
  const userQueryEvents = events.filter(e => e.type === 'user_query_created');
  
  // We should have caught both user queries from the tech specialist
  // If we missed them due to timing, they would have been caught in initialQueries
  const totalExpectedQueries = 2;
  const totalQueriesFound = userQueryEvents.length + initialQueries.length;
  expect(totalQueriesFound).toBe(totalExpectedQueries);
  
  // Verify we get the expected second question (either in events or initial catchup)
  const allQuestions = [
    ...userQueryEvents.map(e => e.data.query.question),
    ...initialQueries.map(q => q.question)
  ];
  
  const hasFirstQuestion = allQuestions.some(q => 
    q.toLowerCase().includes('when did the customer first notice')
  );
  const hasSecondQuestion = allQuestions.some(q => 
    q.toLowerCase().includes('should i proceed with implementing')
  );
  
  expect(hasFirstQuestion).toBe(true);
  expect(hasSecondQuestion).toBe(true);
  
  // Verify all queries are from tech specialist (both caught via events and initial catchup)
  userQueryEvents.forEach(query => {
    expect(query.data.query.agentId).toBe('tech-specialist');
  });
  initialQueries.forEach(query => {
    expect(query.agentId).toBe('tech-specialist');
  });
  
  const responseEvents = events.filter(e => e.type === 'user_query_answered');
  expect(responseEvents.length).toBeGreaterThanOrEqual(1);
  
  const turnCompletedEvents = events.filter(e => e.type === 'turn_completed');
  expect(turnCompletedEvents.length).toBeGreaterThanOrEqual(1);
  
  console.log('✅ Multi-agent conversation E2E test completed successfully');
  
  // Cleanup
  wsClient.disconnect();
  await testEnv.stop();
}, 10000);
