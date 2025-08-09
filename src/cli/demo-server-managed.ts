#!/usr/bin/env bun

/**
 * Demo: Server-Managed Internal Agents
 * 
 * This demo connects to a remote server and asks it to create and manage
 * internal agents. Unlike demo-scenario-remote.ts where agents run locally,
 * this demo delegates ALL agent execution to the server.
 * 
 * Usage:
 *   # Start server first: bun run server
 *   bun run src/cli/demo-server-managed.ts
 *   bun run src/cli/demo-server-managed.ts --ws ws://localhost:3001/api/ws
 */

import { createScenarioConfiguration } from './scenarios/knee-mri-scenario';
import type { UnifiedEvent } from '$src/types/event.types';
import type { TurnBasedScript } from '$src/agents/script/script.types';

// Define turn-based scripts for the demo agents
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
│     Server-Managed Internal Agents Demo            │
│     Knee MRI Prior Authorization                   │
├────────────────────────────────────────────────────┤
│  This demo asks a remote server to create and      │
│  manage internal agents. ALL agent logic runs      │
│  on the server side.                               │
│                                                    │
│  WebSocket URL: ${wsUrl.padEnd(35)}│
╰────────────────────────────────────────────────────╯
`);

// Simple WebSocket RPC client for setup
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
    console.error('\nOr specify a different URL:');
    console.error('   bun run src/cli/demo-server-managed.ts --ws ws://localhost:3001/api/ws');
    process.exit(1);
  }

  // Step 1: Create scenario on the server
  console.log('\n📋 Creating scenario on server...');
  const scenarioConfig = createScenarioConfiguration();
  
  const scenarioResult = await rpcClient.call('createScenario', {
    id: scenarioConfig.metadata.id,
    name: scenarioConfig.metadata.title,
    config: scenarioConfig
  });
  
  if (scenarioResult) {
    console.log(`   ✓ Scenario created: ${scenarioConfig.metadata.title}`);
  } else {
    // Scenario might already exist, continue anyway
    console.log('   ℹ️  Scenario may already exist, continuing...');
  }
  
  // Step 2: Create conversation with agents (no 'kind' property - location is a runtime decision)
  console.log('\n💬 Creating conversation with script agents...');
  const convResult = await rpcClient.call('createConversation', {
    meta: {
      title: 'Server-Managed MRI Auth Demo',
      tags: ['demo', 'server-managed', 'script-agents', 'prior-auth', 'knee-mri'],
      scenarioId: scenarioConfig.metadata.id,
      startingAgentId: 'patient-agent',  // Patient starts the conversation
      agents: [
        { 
          id: 'patient-agent',
          agentClass: 'script',  // Use script agent for predictable behavior
          config: {
            script: patientScript  // Pass the script data in config
          }
        },
        { 
          id: 'insurance-auth-specialist',
          agentClass: 'script',  // Use script agent for predictable behavior
          config: {
            script: insuranceScript  // Pass the script data in config
          }
        }
      ],
      custom: {
        demoType: 'server-managed-scripts'
      }
    }
  });
  
  if (!convResult || !convResult.conversationId) {
    console.error('   ✗ Failed to create conversation');
    rpcClient.close();
    return;
  }
  
  const conversationId = convResult.conversationId;
  console.log(`   ✓ Conversation ${conversationId} created`);
  console.log(`   ✓ Title: "${convResult.title || 'Server-Managed MRI Auth Demo'}"`);
  console.log(`   ✓ Tags: ${['demo', 'server-managed', 'script-agents'].join(', ')}`);
  
  // Step 2b: Explicitly ensure agents are running on the server
  console.log('\n🚀 Ensuring agents are running on server...');
  const ensureResult = await rpcClient.call('ensureAgentsRunning', {
    conversationId,
    agentIds: ['patient-agent', 'insurance-auth-specialist']
  });
  
  if (ensureResult && ensureResult.ensured) {
    console.log('   ✓ Server-side agents ensured:');
    for (const agent of ensureResult.ensured) {
      console.log(`     - ${agent.agentId}: ${agent.status}`);
    }
  }
  
  // Step 3: Verify that the server is managing the agents
  console.log('\n🔍 Checking agent configuration...');
  const snapshotResult = await rpcClient.call('getConversationSnapshot', {
    conversationId
  });
  
  if (snapshotResult) {
    const agents = snapshotResult.metadata?.agents || [];
    console.log('   Agents registered:');
    for (const agent of agents) {
      const hasScript = agent.config?.script ? 'with script' : 'no script';
      console.log(`     - ${agent.id}: class=${agent.agentClass} (${hasScript})`);
    }
    
    if (agents.length > 0) {
      console.log('   ✓ Agents configured and running on server');
    }
  }
  
  // Step 4: Subscribe to events (as an observer only)
  console.log('\n👁️  Subscribing to conversation events...');
  const subResult = await rpcClient.call('subscribe', {
    conversationId,
    includeGuidance: false
  });
  
  if (!subResult || !subResult.subId) {
    console.error('   ✗ Failed to subscribe');
    rpcClient.close();
    return;
  }
  
  console.log(`   ✓ Subscribed as observer (${subResult.subId})`);
  
  // Close RPC client - we'll use a monitoring connection from here
  rpcClient.close();
  
  // Step 5: Monitor the conversation (we're just observing, not participating)
  const monitorWs = new WebSocket(wsUrl);
  let messageCount = 0;
  const startTime = Date.now();
  let turnCount = 0;
  const MAX_TURNS = 20;
  let lastMessageText = '';
  let sameMessageCount = 0;
  
  console.log('\n📡 Monitoring server-managed conversation...');
  console.log('   (All agents are running on the server)\n');
  console.log('─'.repeat(60));
  
  await new Promise<void>((resolve) => {
    monitorWs.onopen = () => {
      monitorWs.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'mon-1',
        method: 'subscribe',
        params: { conversationId, includeGuidance: false }
      }));
    };
    
    monitorWs.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string);
      
      // Handle subscription confirmation
      if (msg.id === 'mon-1') {
        resolve();
      }
      
      // Handle events
      if (msg.method === 'event') {
        const event = msg.params as UnifiedEvent;
        
        if (event.type === 'message') {
          messageCount++;
          
          // Track turns
          if (event.finality === 'turn' || event.finality === 'conversation') {
            turnCount++;
          }
          
          const payload = event.payload as any;
          const agent = event.agentId === 'patient-agent' ? '🧑 Patient' : 
                       event.agentId === 'insurance-auth-specialist' ? '🏢 Insurance' :
                       `📢 ${event.agentId}`;
          const text = payload.text || '';
          
          console.log(`\n${agent} [Turn ${event.turn}]:`);
          console.log('   ' + text.split('\n').join('\n   '));
          
          // Check if we've reached the turn limit
          if (turnCount >= MAX_TURNS && event.finality === 'turn') {
            console.log('\n' + '─'.repeat(60));
            console.log(`⚠️  Turn limit reached (${MAX_TURNS} turns). Agents should conclude soon...`);
          }
          
          // Check for conversation end
          if (event.finality === 'conversation') {
            console.log('\n' + '─'.repeat(60));
            console.log('✅ Conversation completed!');
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`   Total messages: ${messageCount}`);
            console.log(`   Total turns: ${turnCount}`);
            console.log(`   Duration: ${duration}s`);
            console.log('\n📊 Summary:');
            console.log('   - Agents were created and managed by the server');
            console.log('   - This client only observed the conversation');
            console.log('   - All AI/script logic executed server-side');
            
            // Cleanup
            setTimeout(() => {
              console.log('\n🧹 Cleaning up...');
              monitorWs.close();
              console.log('\n✨ Demo complete!\n');
              process.exit(0);
            }, 1000);
          }
        } else if (event.type === 'trace') {
          // Optionally show trace events for debugging
          const payload = event.payload as any;
          if (payload.type === 'thought') {
            console.log(`   💭 [${event.agentId}] Thinking...`);
          }
        }
      }
    };
    
    monitorWs.onerror = (err) => {
      console.error('Monitor WebSocket error:', err);
    };
  });
  
  console.log('\n⏳ Waiting for server-managed agents to begin conversation...\n');
  console.log('─'.repeat(60));
  
  // Keep process alive
  await new Promise(() => {});
}

// Run the demo
runDemo().catch(err => {
  console.error('\n❌ Demo failed:', err);
  process.exit(1);
});