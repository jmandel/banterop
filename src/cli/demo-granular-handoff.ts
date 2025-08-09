#!/usr/bin/env bun

/**
 * Demo: Granular Agent Handoff to Server
 * 
 * This demo shows how to:
 * 1. Create a conversation
 * 2. Start with external agents
 * 3. Selectively hand off specific agents to the server
 * 4. Server maintains those agents across restarts
 * 
 * Usage:
 *   # Start server first: bun run server
 *   bun run src/cli/demo-granular-handoff.ts
 *   bun run src/cli/demo-granular-handoff.ts --ws ws://localhost:3001/api/ws
 */

import { createScenarioConfiguration } from './scenarios/knee-mri-scenario';
import { ScriptAgent } from '$src/agents/script/script.agent';
import type { TurnBasedScript } from '$src/agents/script/script.types';
import { WsTransport } from '$src/agents/runtime/ws.transport';
import type { UnifiedEvent } from '$src/types/event.types';

// Define turn-based scripts
const patientScript: TurnBasedScript = {
  name: 'patient-knee-mri',
  defaultDelay: 100,
  maxTurns: 5,
  turns: [
    [{ kind: 'post', text: 'Hello, I need help with prior authorization for my knee MRI. My doctor says I need one.', finality: 'turn' }],
    [{ kind: 'post', text: 'Yes, I\'ve been having severe knee pain for about 3 weeks now. It\'s getting worse when I walk or climb stairs.', finality: 'turn' }],
    [{ kind: 'post', text: 'I tried physical therapy for 6 weeks as my doctor recommended, but unfortunately it hasn\'t helped. The pain is still about 7 out of 10.', finality: 'turn' }],
    [{ kind: 'post', text: 'Yes, I have the referral from Dr. Smith dated last week. She documented the failed conservative treatment.', finality: 'turn' }],
    [{ kind: 'post', text: 'Thank you so much for your help! When can I schedule the MRI?', finality: 'conversation' }]
  ]
};

const insuranceScript: TurnBasedScript = {
  name: 'insurance-auth-specialist',
  defaultDelay: 100,
  maxTurns: 5,
  turns: [
    [{ kind: 'post', text: 'Hello! I see you need prior authorization for a knee MRI. Let me review your case. Can you tell me about your symptoms?', finality: 'turn' }],
    [{ kind: 'post', text: 'I understand. For insurance approval, we need to verify that conservative treatment was attempted first. Have you tried physical therapy?', finality: 'turn' }],
    [{ kind: 'post', text: 'Thank you for that information. With 6 weeks of failed physical therapy and pain level of 7/10, this meets our criteria. Do you have a referral from your primary care physician?', finality: 'turn' }],
    [{ kind: 'post', text: 'Perfect. Based on your documented symptoms, failed conservative treatment, and physician referral, I can approve the prior authorization for your knee MRI.', finality: 'turn' }],
    [{ kind: 'post', text: 'Your prior authorization has been approved. Reference number: PA-2024-KM-' + Math.floor(Math.random() * 10000) + '. You can call your doctor\'s office to schedule the MRI. The authorization is valid for 30 days.', finality: 'conversation' }]
  ]
};

// Parse command line arguments
const args = process.argv.slice(2);
const wsUrlIndex = args.indexOf('--ws');
const wsUrl: string = (wsUrlIndex !== -1 && wsUrlIndex + 1 < args.length) 
  ? args[wsUrlIndex + 1]! 
  : 'ws://localhost:3000/api/ws';

console.log(`
╭────────────────────────────────────────────────────╮
│     Granular Agent Handoff Demo                    │
│     Knee MRI Prior Authorization                   │
├────────────────────────────────────────────────────┤
│  This demo shows selective agent handoff:          │
│  1. Start with external agents                     │
│  2. Hand off specific agents to server             │
│  3. Server maintains them across restarts          │
│                                                    │
│  WebSocket URL: ${wsUrl.padEnd(35)}│
╰────────────────────────────────────────────────────╯
`);

// Simple WebSocket RPC client
class WsRpcClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, (result: any) => void>();
  private idCounter = 1;

  constructor(private url: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      
      this.ws.onopen = () => {
        console.log('   ✓ Connected to server');
        resolve();
      };
      
      this.ws.onerror = (err) => {
        console.error('   ✗ WebSocket error:', err);
        reject(err);
      };
      
      this.ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string);
          if (msg.id && this.pending.has(msg.id)) {
            const resolver = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) {
              console.error('RPC Error:', msg.error);
              resolver(null);
            } else {
              resolver(msg.result);
            }
          }
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      };
    });
  }

  async call(method: string, params: any): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    return new Promise((resolve) => {
      const id = `req-${this.idCounter++}`;
      this.pending.set(id, resolve);
      
      this.ws!.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      }));
      
      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve(null);
        }
      }, 5000);
    });
  }

  close() {
    this.ws?.close();
  }
}

async function runDemo() {
  console.log('\n🔌 Connecting to server...');
  const rpcClient = new WsRpcClient(wsUrl);
  
  try {
    await rpcClient.connect();
  } catch (err) {
    console.error('\n❌ Failed to connect to server at', wsUrl);
    console.error('\n💡 Make sure the server is running:');
    console.error('   bun run dev');
    process.exit(1);
  }

  // Step 1: Create scenario
  console.log('\n📋 Creating scenario on server...');
  const scenarioConfig = createScenarioConfiguration();
  
  await rpcClient.call('createScenario', {
    id: scenarioConfig.metadata.id,
    name: scenarioConfig.metadata.title,
    config: scenarioConfig
  });
  console.log('   ✓ Scenario ready');
  
  // Step 2: Create conversation with ALL agents marked as EXTERNAL initially
  console.log('\n💬 Creating conversation with external agents...');
  const convResult = await rpcClient.call('createConversation', {
    meta: {
      title: 'Granular Handoff Demo',
      scenarioId: scenarioConfig.metadata.id,
      startingAgentId: 'patient-agent',
      agents: [
        { id: 'patient-agent', kind: 'external' },  // Start as external
        { id: 'insurance-auth-specialist', kind: 'external' }  // Start as external
      ]
    }
  });
  
  if (!convResult || !convResult.conversationId) {
    console.error('   ✗ Failed to create conversation');
    rpcClient.close();
    return;
  }
  
  const conversationId = convResult.conversationId;
  console.log(`   ✓ Conversation ${conversationId} created with external agents`);
  
  // Step 3: Start patient agent locally (external)
  console.log('\n🤖 Starting patient agent locally (external)...');
  const patientTransport = new WsTransport(wsUrl);
  const patientAgent = new ScriptAgent(patientTransport, patientScript);
  await patientAgent.start(conversationId, 'patient-agent');
  console.log('   ✓ Patient agent running locally');
  
  // Step 4: Monitor conversation
  console.log('\n👁️  Monitoring conversation...');
  const monitorWs = new WebSocket(wsUrl);
  let messageCount = 0;
  let handoffDone = false;
  
  await new Promise<void>((resolve) => {
    monitorWs.onopen = () => {
      monitorWs.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'mon-1',
        method: 'subscribe',
        params: { conversationId, includeGuidance: false }
      }));
    };
    
    monitorWs.onmessage = async (evt) => {
      const msg = JSON.parse(evt.data as string);
      
      if (msg.id === 'mon-1') {
        console.log('   ✓ Subscribed to events\n');
        console.log('─'.repeat(60));
        resolve();
      }
      
      if (msg.method === 'event') {
        const event = msg.params as UnifiedEvent;
        
        if (event.type === 'message') {
          messageCount++;
          const payload = event.payload as any;
          const agent = event.agentId === 'patient-agent' ? '🧑 Patient (external)' : 
                       event.agentId === 'insurance-auth-specialist' ? '🏢 Insurance' :
                       `📢 ${event.agentId}`;
          
          console.log(`\n${agent} [Turn ${event.turn}]:`);
          console.log('   ' + payload.text?.split('\n').join('\n   '));
          
          // After 2 messages, hand off insurance agent to server
          if (messageCount === 2 && !handoffDone) {
            handoffDone = true;
            console.log('\n' + '─'.repeat(60));
            console.log('\n🔄 HANDOFF: Transferring insurance agent to server...');
            
            // Hand off insurance agent to server
            const handoffResult = await rpcClient.call('startAgents', {
              conversationId,
              agentIds: ['insurance-auth-specialist']
            });
            
            if (handoffResult?.started) {
              console.log('   ✓ Insurance agent now managed by server');
              console.log('   ℹ️  Patient remains external (local)');
              console.log('\n' + '─'.repeat(60));
              
              // Update display for future messages
              setTimeout(() => {
                monitorWs.onmessage = async (evt2) => {
                  const msg2 = JSON.parse(evt2.data as string);
                  if (msg2.method === 'event') {
                    const event2 = msg2.params as UnifiedEvent;
                    if (event2.type === 'message') {
                      const payload2 = event2.payload as any;
                      const agent2 = event2.agentId === 'patient-agent' ? '🧑 Patient (external)' : 
                                   event2.agentId === 'insurance-auth-specialist' ? '🏢 Insurance (server-managed)' :
                                   `📢 ${event2.agentId}`;
                      
                      console.log(`\n${agent2} [Turn ${event2.turn}]:`);
                      console.log('   ' + payload2.text?.split('\n').join('\n   '));
                      
                      if (event2.finality === 'conversation') {
                        console.log('\n' + '─'.repeat(60));
                        console.log('✅ Conversation completed!');
                        console.log('\n📊 Summary:');
                        console.log('   - Patient agent: Remained external (local) throughout');
                        console.log('   - Insurance agent: Handed off to server mid-conversation');
                        console.log('   - Server will maintain insurance agent across restarts');
                        
                        setTimeout(() => {
                          console.log('\n🧹 Cleaning up...');
                          patientAgent.stop();
                          patientTransport.close();
                          monitorWs.close();
                          rpcClient.close();
                          console.log('\n✨ Demo complete!\n');
                          process.exit(0);
                        }, 1000);
                      }
                    }
                  }
                };
              }, 100);
            } else {
              console.error('   ✗ Failed to hand off agent');
            }
          }
        }
      }
    };
  });
  
  console.log('\n⏳ Conversation starting...\n');
  console.log('─'.repeat(60));
  
  // Keep process alive
  await new Promise(() => {});
}

// Run the demo
runDemo().catch(err => {
  console.error('\n❌ Demo failed:', err);
  process.exit(1);
});