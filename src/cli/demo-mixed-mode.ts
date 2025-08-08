#!/usr/bin/env bun
// Demo 4: Mixed Server/Client Agent Execution
//
// This demo shows running some agents on the server and others on the client:
// 1. Create a conversation with both internal and external agents
// 2. Internal agents run on the server via runConversationToCompletion
// 3. External agents run on the client via WsTransport
// 4. Both types of agents interact seamlessly through the orchestrator
// 5. Demonstrates true transport-agnostic design

import { startAgents } from '$src/agents/factories/agent.factory';
import { WsTransport } from '$src/agents/runtime/ws.transport';
import { ProviderManager } from '$src/llm/provider-manager';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';

// Connect to existing server
const WS_URL = process.env.WS_URL || 'ws://localhost:3000/api/ws';
console.log(`🔌 Connecting to server at ${WS_URL}...`);

// Create WebSocket client
const ws = new WebSocket(WS_URL);
let reqId = 1;

function sendRequest(method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = reqId++;
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.id === id) {
        ws.removeEventListener('message', handler);
        if (data.error) {
          reject(new Error(data.error.message));
        } else {
          resolve(data.result);
        }
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

ws.onopen = async () => {
  console.log('✅ Connected to server\n');
  
  try {
    // Track lastClosedSeq for the conversation
    let lastClosedSeq = 0;
    // Step 1: Create a medical scenario for demonstration
    console.log('📋 Creating medical authorization scenario...');
    const medicalScenario: ScenarioConfiguration = {
      metadata: {
        id: 'medical-auth-demo-v2',
        name: 'Medical Authorization Demo',
        description: 'Provider requests authorization from insurer',
        version: '1.0.0'
      },
      agents: [
        {
          agentId: 'provider',
          principal: 'Healthcare Provider',
          goal: 'Obtain authorization for patient treatment',
          systemPrompt: 'You are a healthcare provider requesting authorization for a medical procedure.'
        },
        {
          agentId: 'insurer',
          principal: 'Insurance Company',
          goal: 'Review and process authorization requests',
          systemPrompt: 'You are an insurance company representative reviewing authorization requests.'
        },
        {
          agentId: 'patient',
          principal: 'Patient Representative',
          goal: 'Ensure appropriate care is authorized',
          systemPrompt: 'You represent the patient in the authorization process.'
        },
        {
          agentId: 'coordinator',
          principal: 'Care Coordinator',
          goal: 'Facilitate the authorization process',
          systemPrompt: 'You are coordinating the authorization request process.'
        }
      ],
      knowledge: {
        sharedFacts: [
          'Patient: John Doe, DOB: 1980-01-15',
          'Insurance ID: INS-123456',
          'Procedure: MRI Scan',
          'Diagnosis: Lower back pain, chronic'
        ]
      }
    };
    
    await sendRequest('createScenario', {
      id: medicalScenario.metadata.id,
      name: medicalScenario.metadata.name,
      config: medicalScenario
    }).catch(() => console.log('  (Scenario may already exist)'));
    
    // Step 2: Create conversation with mixed agent types
    console.log('\n🎭 Creating conversation with mixed agent types...');
    const { conversationId } = await sendRequest('createConversation', {
      meta: {
        title: 'Mixed Mode Medical Authorization',
        description: 'Provider (server) and Insurer (client) negotiate, Patient observes',
        scenarioId: 'medical-auth-demo-v2',
        agents: [
          {
            id: 'provider',
            kind: 'internal', // Runs on server
            displayName: 'Dr. Smith (Provider)',
            agentClass: 'AssistantAgent',
            config: { llmProvider: 'mock' }
          },
          {
            id: 'insurer',
            kind: 'external', // Runs on client
            displayName: 'Blue Shield Rep',
            agentClass: 'AssistantAgent',
            config: { llmProvider: 'mock' }
          },
          {
            id: 'patient',
            kind: 'internal', // Runs on server
            displayName: 'John Doe (Patient)',
            agentClass: 'EchoAgent'
          },
          {
            id: 'coordinator',
            kind: 'external', // External coordinator (us)
            displayName: 'Care Coordinator'
          }
        ]
      }
    });
    console.log(`✅ Created conversation ${conversationId}`);
    
    // Step 3: Subscribe to monitor all events
    console.log('\n👀 Setting up event monitoring...');
    const { subId } = await sendRequest('subscribe', {
      conversationId,
      includeGuidance: true
    });
    
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'event') {
        const e = data.params;
        if (e.type === 'message') {
          const location = e.agentId === 'insurer' ? '📱 CLIENT' : '☁️ SERVER';
          console.log(`[${location}] ${e.agentId}: ${e.payload.text}`);
          // Update lastClosedSeq when we see a message that closes a turn
          if (e.finality !== 'none' && e.seq) {
            lastClosedSeq = e.seq;
          }
        }
      } else if (data.method === 'guidance') {
        console.log(`🎯 Next turn: ${data.params.nextAgentId}`);
      }
    });
    
    // Step 4: Start server-side agents
    console.log('\n☁️ Starting server-side agents...');
    await sendRequest('runConversationToCompletion', { conversationId });
    console.log('  ✓ Provider agent running on server');
    console.log('  ✓ Patient agent running on server');
    
    // Step 5: Start client-side agents
    console.log('\n📱 Starting client-side agents...');
    const clientProvider = new ProviderManager({ defaultLlmProvider: 'mock' });
    
    const clientAgents = await startAgents({
      conversationId,
      transport: new WsTransport(WS_URL),
      providerManager: clientProvider,
      agentIds: ['insurer'] // Only the insurer runs on client
    });
    console.log('  ✓ Insurer agent running on client');
    
    // Step 6: Initiate the conversation
    console.log('\n💬 Starting authorization request...\n');
    console.log('─'.repeat(60));
    await sendRequest('sendMessage', {
      conversationId,
      agentId: 'coordinator',
      messagePayload: { 
        text: 'Provider, please submit the authorization request for the MRI scan.',
        attachments: [{
          name: 'patient-record.json',
          contentType: 'application/json',
          content: JSON.stringify({
            patientId: 'INS-123456',
            procedure: 'MRI Scan',
            diagnosis: 'Lower back pain',
            urgency: 'routine'
          }),
          summary: 'Patient medical record'
        }]
      },
      finality: 'turn',
      precondition: { lastClosedSeq }
    });
    
    // Let the conversation flow
    await new Promise(resolve => setTimeout(resolve, 4000));
    
    // Coordinator prompts for resolution
    console.log('\n💬 Requesting status update...\n');
    console.log('─'.repeat(60));
    await sendRequest('sendMessage', {
      conversationId,
      agentId: 'coordinator',
      messagePayload: { text: 'Insurer, what is your determination on this authorization request?' },
      finality: 'turn',
      precondition: { lastClosedSeq }
    });
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Final message
    console.log('\n💬 Concluding authorization process...\n');
    console.log('─'.repeat(60));
    await sendRequest('sendMessage', {
      conversationId,
      agentId: 'coordinator',
      messagePayload: { text: 'Thank you all. The authorization process is now complete.' },
      finality: 'conversation',
      precondition: { lastClosedSeq }
    });
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('📊 Mixed Mode Execution Summary:');
    console.log('  • Provider agent: Executed on SERVER');
    console.log('  • Insurer agent:  Executed on CLIENT');
    console.log('  • Patient agent:  Executed on SERVER');
    console.log('  • All agents communicated seamlessly via orchestrator');
    console.log('═'.repeat(60));
    
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await clientAgents.stop();
    await sendRequest('unsubscribe', { subId });
    ws.close();
    
    console.log('✅ Demo complete!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    ws.close();
    process.exit(1);
  }
};

ws.onerror = (error) => {
  console.error('❌ WebSocket error:', error);
  process.exit(1);
};