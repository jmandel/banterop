// Multi-Agent Demo Using Transport-Agnostic Client Architecture
// Demonstrates how ProgrammaticAgent enables custom logic with dependency injection

import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { createClient } from '$client/index.js';
import { ProgrammaticAgent } from '$agents/index.js';
import type { AgentConfig, CreateConversationRequest, ConversationEvent, ProgrammaticAgentConfig } from '$lib/types.js';

console.log('🚀 Client-Based Agent Demo - Transport-Agnostic Architecture');

// --- Define Agent Logic as Handler Functions ---

const supportAgentLogic = async (agent: ProgrammaticAgent, event: ConversationEvent) => {
  console.log(`💬 ${agent.agentId.label} saw a turn from ${event.data.turn.agentId}`);
  
  if (event.data.turn.agentId === 'tech-specialist' && event.data.turn.content.includes('recommend')) {
    await agent.submitStreamingTurn(
      'Thank you for the technical analysis! I\'ll contact the customer immediately with these recommendations and gather the additional information you need for further optimization.',
      [
        'I need to translate the technical recommendations into customer-friendly guidance',
        'I should also schedule a follow-up to ensure proper implementation'
      ],
      [{
        name: 'create_customer_response',
        parameters: { 
          technical_details: 'connection pooling and database scaling',
          urgency: 'high'
        },
        result: { template_created: true, customer_priority: 'high' }
      }]
    );
  }
};

const techSpecialistLogic = async (agent: ProgrammaticAgent, event: ConversationEvent) => {
  console.log(`🔧 ${agent.agentId.label} saw a turn from ${event.data.turn.agentId}`);
  
  if (event.data.turn.agentId === 'support-agent' && 
      (event.data.turn.content.includes('technical issue') || 
       event.data.turn.content.includes('database connection'))) {
    
    await agent.submitStreamingTurn(
      'I\'ve analyzed the issue. The database is experiencing high load with 180 active connections and 45-second response times. I recommend implementing connection pooling and possibly scaling the database instance. Can you ask the customer about their current connection management strategy?',
      [
        'I need to analyze this database connection timeout issue systematically',
        'Let me check the current database performance metrics',
        'Based on the results, I can provide specific recommendations'
      ],
      [{
        name: 'check_database_status',
        parameters: { timeout_threshold: 30 },
        result: { status: 'degraded', avg_response_time: 45000, active_connections: 180 }
      }, {
        name: 'analyze_connection_patterns',
        parameters: { timeframe: '24h' },
        result: { connection_spikes: true, peak_hours: ['09:00-11:00', '14:00-16:00'], pool_utilization: 0.95 }
      }]
    );
  }
  
  // Offer additional resources when support agent confirms understanding
  if (event.data.turn.agentId === 'support-agent' && 
      event.data.turn.content.includes('contact the customer')) {
    
    await agent.submitStreamingTurn(
      'Perfect approach! Additionally, I can provide the customer with a connection pooling configuration template and monitoring scripts to track their database performance. Would you like me to prepare these resources?',
      [
        'Offering proactive technical resources will help prevent future issues',
        'I should prepare comprehensive documentation for the customer'
      ]
    );
  }
};

// --- Main Demo Runner ---

async function runClientDemo(): Promise<void> {
  try {
    console.log('\n1️⃣ Creating in-process orchestrator...');
    const orchestrator = new ConversationOrchestrator(':memory:');

    console.log('\n2️⃣ Defining conversation with programmatic agents...');
    const createRequest: CreateConversationRequest = {
      name: 'Customer Support - Client Demo',
      agents: [
        {
          agentId: { id: 'support-agent', label: 'Support Agent', role: 'assistant' },
          strategyType: 'programmatic',
          handler: supportAgentLogic,
        } as ProgrammaticAgentConfig,
        {
          agentId: { id: 'tech-specialist', label: 'Tech Specialist', role: 'specialist' },
          strategyType: 'programmatic',
          handler: techSpecialistLogic,
        } as ProgrammaticAgentConfig
      ],
    };

    const { conversation, agentTokens } = await orchestrator.createConversation(createRequest);
    console.log(`✅ Conversation created: ${conversation.id}`);

    console.log('\n3️⃣ Creating and initializing agents with dependency injection...');
    
    // Create clients for each agent using the factory
    const supportClient = createClient('in-process', orchestrator);
    const techClient = createClient('in-process', orchestrator);

    // Manually instantiate our programmatic agents
    const supportAgent = new ProgrammaticAgent(createRequest.agents[0] as ProgrammaticAgentConfig, supportClient);
    const techSpecialist = new ProgrammaticAgent(createRequest.agents[1] as ProgrammaticAgentConfig, techClient);

    await Promise.all([
        supportAgent.initialize(conversation.id, agentTokens['support-agent']),
        techSpecialist.initialize(conversation.id, agentTokens['tech-specialist']),
    ]);
    console.log('✅ Both agents initialized');

    console.log('\n4️⃣ Running demo conversation...');
    
    // Create a runner client to start the conversation
    const runnerClient = createClient('in-process', orchestrator);
    await runnerClient.connect(agentTokens['support-agent']);
    await runnerClient.authenticate(agentTokens['support-agent']);
    
    // Start the conversation
    // TODO: Update to use new streaming pattern (startTurn + completeTurn)
    // await runnerClient.submitTurn(
      "Hello! I have a customer with a technical issue that needs specialist attention. The customer is experiencing database connection timeouts.",
      []
    );
    
    // Wait for conversation to develop
    console.log('⏳ Waiting for agent interactions...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('\n5️⃣ Final conversation summary...');
    const finalConversation = orchestrator.getConversation(conversation.id, true, true);
    console.log(`✅ Conversation has ${finalConversation.turns.length} turns total`);
    
    finalConversation.turns.forEach((turn: any, index: number) => {
      console.log(`   ${index + 1}. ${turn.agentId}: "${turn.content.slice(0, 80)}..." (${turn.trace?.length || 0} trace entries)`);
    });

    console.log('\n6️⃣ Cleaning up...');
    await Promise.all([
      supportAgent.shutdown(),
      techSpecialist.shutdown()
    ]);
    runnerClient.disconnect();
    orchestrator.close();
    console.log('✅ All agents and orchestrator shut down');

    console.log('\n🎉 Client-based demo completed successfully!');
    console.log('\n💡 Key advantages of the client-based architecture:');
    console.log('   ✅ No need for separate demo agent classes - everything uses standard agents');
    console.log('   ✅ ProgrammaticAgent allows custom logic via simple handler functions');
    console.log('   ✅ All agents use the same transport-agnostic client interface');
    console.log('   ✅ Clean dependency injection pattern throughout');
    console.log('   ✅ Same agent logic works with WebSocket, in-process, or any future transport');

  } catch (error: any) {
    console.error('❌ Refactored demo failed:', error.message);
    process.exit(1);
  }
}

async function runComparisonDemo(): Promise<void> {
  console.log('\n🔄 === Comparison Demo: Same Logic, Different Transports ===\n');
  
  try {
    // First, create the same agents using in-process transport
    console.log('🏠 Testing with IN-PROCESS transport...');
    const orchestrator1 = new ConversationOrchestrator(':memory:');
    const supportClient1 = createClient('in-process', orchestrator1);
    const { conversation: conv1, agentTokens: tokens1 } = orchestrator1.createConversation({
      name: 'In-Process Test',
      agents: [{
        agentId: { id: 'support-agent', label: 'Support Agent', role: 'assistant' },
        strategyType: 'programmatic',
        handler: supportAgentLogic,
      } as ProgrammaticAgentConfig]
    });
    
    const agent1 = new ProgrammaticAgent(
      { agentId: { id: 'support-agent', label: 'Support Agent', role: 'assistant' }, strategyType: 'programmatic', handler: supportAgentLogic },
      supportClient1
    );
    await agent1.initialize(conv1.id, tokens1['support-agent']);
    // TODO: Update to use new streaming pattern (startTurn + completeTurn)
    // await supportClient1.submitTurn('Test turn via in-process', []);
    await agent1.shutdown();
    orchestrator1.close();
    console.log('✅ In-process test completed');

    // Note: WebSocket test would require a running server, so we'll skip it in this demo
    console.log('🌐 WebSocket transport would work identically with running server');
    
    console.log('\n🎊 Transport comparison completed - same agent logic, different transports!');
    
  } catch (error: any) {
    console.error('❌ Comparison demo failed:', error.message);
  }
}

// --- Execution ---

async function main(): Promise<void> {
  const mode = process.argv[2] || 'full';
  
  switch (mode) {
    case 'full':
      await runClientDemo();
      await runComparisonDemo();
      break;
    case 'demo':
      await runClientDemo();
      break;
    case 'comparison':
      await runComparisonDemo();
      break;
    default:
      console.log('Usage: bun demos/client-agent-demo.ts [full|demo|comparison]');
      process.exit(1);
  }
  
  process.exit(0);
}

main();