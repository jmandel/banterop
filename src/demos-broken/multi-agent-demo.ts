// Refactored Multi-Agent Demo with Dependency Injection
// Demonstrates the new client interface architecture with transport decoupling

import { ConversationOrchestrator, createUnifiedAPI } from '$backend/core/orchestrator.js';
import { createClient } from '$client/index.js';
import { DemoOrchestrator } from './multi-agent-logic.js';
import type { AgentConfig, CreateConversationRequest } from '$lib/types.js';

console.log('🤖 Multi-Agent Conversation Demo (Refactored)');
console.log('📡 HTTP Server: http://localhost:3000');
console.log('🔌 WebSocket: ws://localhost:3000/ws');
console.log('🆕 Now using dependency injection pattern!');

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runWebSocketDemo(): Promise<void> {
  console.log('\n🌐 === WebSocket Mode Demo ===\n');

  try {
    // Test server connectivity
    console.log('🔍 Testing server connectivity...');
    const response = await fetch('http://localhost:3000/conversations', { method: 'GET' });
    if (!response.ok && response.status !== 404) {
      throw new Error('Server not accessible');
    }
    console.log('✅ Server is accessible');

    // Create conversation
    console.log('\n1️⃣ Creating conversation...');
    const agentConfigs: AgentConfig[] = [
      {
        agentId: { id: 'support-agent', label: 'Customer Support Agent', role: 'assistant' },
        strategyType: 'static_replay',
        script: [] // Will be handled by our agent logic
      } as any,
      {
        agentId: { id: 'tech-specialist', label: 'Technical Specialist', role: 'specialist' },
        strategyType: 'static_replay', 
        script: [] // Will be handled by our agent logic
      } as any
    ];

    const createRequest: CreateConversationRequest = {
      name: 'Customer Support - Technical Issue (WebSocket)',
      agents: agentConfigs
    };

    const createResponse = await fetch('http://localhost:3000/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createRequest)
    });

    if (!createResponse.ok) {
      throw new Error(`Failed to create conversation: ${createResponse.statusText}`);
    }

    const { conversation, agentTokens } = await createResponse.json();
    console.log(`✅ Conversation created: ${conversation.id}`);

    // Create WebSocket clients using the factory
    console.log('\n2️⃣ Creating WebSocket clients via factory...');
    const supportClient = createClient('websocket', 'ws://localhost:3000/ws');
    const techClient = createClient('websocket', 'ws://localhost:3000/ws');
    console.log('✅ WebSocket clients created');

    // Create demo orchestrator with injected clients
    console.log('\n3️⃣ Creating demo orchestrator with dependency injection...');
    const demoOrchestrator = new DemoOrchestrator(supportClient, techClient);
    console.log('✅ Demo orchestrator created with injected clients');

    // Initialize agents
    console.log('\n4️⃣ Initializing agents...');
    await demoOrchestrator.initializeAgents(conversation.id, agentTokens);
    console.log('✅ Both agents initialized');

    // Run the demo conversation
    console.log('\n5️⃣ Running demo conversation...');
    await demoOrchestrator.runDemo();

    // Cleanup
    console.log('\n6️⃣ Cleaning up...');
    await demoOrchestrator.shutdown();
    console.log('✅ All agents shut down');

    // Get final conversation state via one of the clients
    console.log('\n7️⃣ Final conversation summary...');
    const finalClient = createClient('websocket', 'ws://localhost:3000/ws');
    await finalClient.connect(agentTokens['support-agent']);
    await finalClient.authenticate(agentTokens['support-agent']);
    
    const finalConversation = await finalClient.getConversation(conversation.id, {
      includeTurns: true,
      includeTrace: true
    });

    console.log(`✅ Conversation has ${finalConversation.turns.length} turns total`);
    finalConversation.turns.forEach((turn: any, index: number) => {
      console.log(`   ${index + 1}. ${turn.agentId}: "${turn.content.slice(0, 60)}..." (${turn.trace?.length || 0} trace entries)`);
    });
    
    finalClient.disconnect();

    console.log('\n🎉 WebSocket demo completed successfully!');
    
  } catch (error: any) {
    console.error('❌ WebSocket demo failed:', error.message);
    throw error;
  }
}

async function runInProcessDemo(): Promise<void> {
  console.log('\n🏠 === In-Process Mode Demo ===\n');

  try {
    // Create in-process orchestrator
    console.log('1️⃣ Creating in-process orchestrator...');
    const orchestrator = new ConversationOrchestrator(':memory:');
    console.log('✅ In-process orchestrator created');

    // Create conversation directly
    console.log('\n2️⃣ Creating conversation directly via orchestrator...');
    const agentConfigs: AgentConfig[] = [
      {
        agentId: { id: 'support-agent', label: 'Customer Support Agent', role: 'assistant' },
        strategyType: 'static_replay',
        script: []
      } as any,
      {
        agentId: { id: 'tech-specialist', label: 'Technical Specialist', role: 'specialist' },
        strategyType: 'static_replay',
        script: []
      } as any
    ];

    const createRequest: CreateConversationRequest = {
      name: 'Customer Support - Technical Issue (In-Process)',
      agents: agentConfigs
    };

    const { conversation, agentTokens } = orchestrator.createConversation(createRequest);
    console.log(`✅ Conversation created: ${conversation.id}`);

    // Create in-process clients using the factory  
    console.log('\n3️⃣ Creating in-process clients via factory...');
    const supportClient = createClient('in-process', orchestrator);
    const techClient = createClient('in-process', orchestrator);
    console.log('✅ In-process clients created');

    // Create demo orchestrator with injected clients
    console.log('\n4️⃣ Creating demo orchestrator with dependency injection...');
    const demoOrchestrator = new DemoOrchestrator(supportClient, techClient);
    console.log('✅ Demo orchestrator created with injected clients');

    // Initialize agents
    console.log('\n5️⃣ Initializing agents...');
    await demoOrchestrator.initializeAgents(conversation.id, agentTokens);
    console.log('✅ Both agents initialized');

    // Run the demo conversation
    console.log('\n6️⃣ Running demo conversation...');
    await demoOrchestrator.runDemo();

    // Cleanup
    console.log('\n7️⃣ Cleaning up...');
    await demoOrchestrator.shutdown();
    console.log('✅ All agents shut down');

    // Get final conversation state directly from orchestrator
    console.log('\n8️⃣ Final conversation summary...');
    const finalConversation = orchestrator.getConversation(conversation.id, true, true);
    
    console.log(`✅ Conversation has ${finalConversation.turns.length} turns total`);
    finalConversation.turns.forEach((turn: any, index: number) => {
      console.log(`   ${index + 1}. ${turn.agentId}: "${turn.content.slice(0, 60)}..." (${turn.trace?.length || 0} trace entries)`);
    });

    // Cleanup orchestrator
    orchestrator.close();

    console.log('\n🎉 In-process demo completed successfully!');
    
  } catch (error: any) {
    console.error('❌ In-process demo failed:', error.message);
    throw error;
  }
}

async function runBothModes(): Promise<void> {
  const mode = process.argv[2] || 'both';
  
  try {
    switch (mode) {
      case 'websocket':
        await runWebSocketDemo();
        break;
        
      case 'in-process':
        await runInProcessDemo();
        break;
        
      case 'both':
      default:
        await runWebSocketDemo();
        await sleep(2000);
        await runInProcessDemo();
        break;
    }

    console.log('\n🎊 All demos completed successfully!');
    console.log('\n💡 Key benefits of the new architecture:');
    console.log('   ✅ Agent logic is completely transport-agnostic');
    console.log('   ✅ Same agent classes work with WebSocket AND in-process clients');
    console.log('   ✅ Easy to test agents in high-speed in-process mode');
    console.log('   ✅ Clean separation of concerns via dependency injection');
    console.log('   ✅ Flexible deployment: distributed (WebSocket) or embedded (in-process)');
    
    console.log('\n📚 Usage:');
    console.log('   bun run demos/multi-agent-demo.ts websocket   # WebSocket mode only');
    console.log('   bun run demos/multi-agent-demo.ts in-process  # In-process mode only'); 
    console.log('   bun run demos/multi-agent-demo.ts both        # Both modes (default)');
    
    process.exit(0);
    
  } catch (error: any) {
    console.error('❌ Demo failed:', error.message);
    process.exit(1);
  }
}

// Run the demo
runBothModes();