/**
 * Safer E2E Test: Multi-Agent Conversation with User Query Integration
 * Uses event-driven approach instead of polling
 */

import type { ConversationEvent, UserQueryCreatedEvent, SequentialScriptConfig } from '$lib/types.js';
import { WebSocketJsonRpcClient } from '$client/impl/websocket.client.js';
import { expect, test } from 'bun:test';
import { TestEnvironment, waitForCondition } from '../utils/test-helpers.js';

test('multi-agent workflow with user queries (event-driven)', async () => {
  const testEnv = new TestEnvironment();
  await testEnv.start();
  
  // Define scripted agents for the conversation
  const supportAgentConfig: SequentialScriptConfig = {
    agentId: { id: 'support-agent', label: 'Support Agent', role: 'assistant' },
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
    agentId: { id: 'tech-specialist', label: 'Tech Specialist', role: 'specialist' },
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
  
  // Set up query responses BEFORE creating conversation
  const queryResponses = new Map([
    ['initial_analysis', 'The issues started yesterday around 3 PM during peak traffic'],
    ['approval', 'Yes, please proceed with the maintenance window']
  ]);
  
  // Track events and queries
  const events: ConversationEvent[] = [];
  const pendingQueries: Map<string, UserQueryCreatedEvent> = new Map();
  let queryResponsesHandled = 0;
  
  // Connect to WebSocket BEFORE creating conversation
  const wsClient = new WebSocketJsonRpcClient(testEnv.wsUrl!);
  await wsClient.connect();
  
  try {
    // Create conversation first
    const createResponse = await fetch(`${testEnv.httpUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Multi-Agent E2E Test (Safer)',
        agents: [supportAgentConfig, techAgentConfig],
        managementMode: 'internal'
      })
    });
    
    const { conversation, agentTokens } = await createResponse.json();
    const conversationId = conversation.id;
    
    // Authenticate and subscribe BEFORE starting conversation
    await wsClient.authenticate(Object.values(agentTokens)[0] as string);
    await wsClient.subscribe(conversationId);
    
    // Set up event-driven query responder BEFORE starting conversation
    wsClient.on('event', async (event: ConversationEvent) => {
      events.push(event);
      console.log(`Event: ${event.type}`);
      
      // Handle user query events
      if (event.type === 'user_query_created') {
        const queryEvent = event as UserQueryCreatedEvent;
        const query = queryEvent.data.query;
        pendingQueries.set(query.queryId, queryEvent);
        
        // Respond based on context
        const responseKey = query.context?.stage;
        if (responseKey && queryResponses.has(responseKey)) {
          console.log(`Responding to query: ${query.question}`);
          try {
            // Small delay to simulate user thinking
            await new Promise(resolve => setTimeout(resolve, 100));
            
            await wsClient.respondToUserQuery(
              query.queryId,
              queryResponses.get(responseKey)!
            );
            queryResponsesHandled++;
            console.log(`Query answered (${queryResponsesHandled}/${queryResponses.size})`);
          } catch (error) {
            console.error('Error answering query:', error);
          }
        }
      }
    });
    
    // NOW start the conversation after handlers are set up
    const startResponse = await fetch(`${testEnv.httpUrl}/conversations/${conversationId}/start`, {
      method: 'POST'
    });
    expect(startResponse.ok).toBe(true);
    
    // Wait for conversation to start
    await waitForCondition(
      () => events.some(e => e.type === 'turn_completed' && e.data.turn.agentId === 'support-agent'),
      5000
    );
    
    // Wait for all expected queries to be handled
    await waitForCondition(
      () => queryResponsesHandled === queryResponses.size,
      10000
    );
    
    // Wait for final response
    await waitForCondition(
      () => events.some(e => 
        e.type === 'turn_completed' && 
        e.data.turn.agentId === 'tech-specialist' &&
        e.data.turn.content.includes('connection pooling')
      ),
      5000
    );
    
    // Validate the conversation flow
    const supportTurns = events.filter(e => e.type === 'turn_completed' && e.data.turn.agentId === 'support-agent');
    const techTurns = events.filter(e => e.type === 'turn_completed' && e.data.turn.agentId === 'tech-specialist');
    const queryEvents = events.filter(e => e.type === 'user_query_created');
    const answerEvents = events.filter(e => e.type === 'user_query_answered');
    
    console.log(`Support turns: ${supportTurns.length}, Tech turns: ${techTurns.length}`);
    console.log(`Queries created: ${queryEvents.length}, Queries answered: ${answerEvents.length}`);
    
    expect(supportTurns.length).toBeGreaterThan(0);
    expect(techTurns.length).toBeGreaterThan(0);
    expect(pendingQueries.size).toBe(2);
    expect(queryResponsesHandled).toBe(2);
    
  } finally {
    // Clean up - this ALWAYS runs
    wsClient.disconnect();
    await testEnv.stop();
  }
}, 20000);