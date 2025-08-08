#!/usr/bin/env bun

/**
 * Demo: Remote scenario agents connecting via WebSocket
 * 
 * This demo connects to a remote orchestrator and runs scenario-driven agents
 * locally that communicate with the server via WebSocket.
 * 
 * Usage:
 *   # Start server first: bun run server
 *   bun run src/cli/demo-scenario-remote.ts
 *   bun run src/cli/demo-scenario-remote.ts --ws ws://localhost:3001/api/ws
 *   bun run src/cli/demo-scenario-remote.ts --conversation 5
 */

import { ScenarioDrivenAgent } from '$src/agents/scenario/scenario-driven.agent';
import { ScriptAgent } from '$src/agents/script/script.agent';
import type { TurnBasedScript } from '$src/agents/script/script.types';
import { WsTransport } from '$src/agents/runtime/ws.transport';
import { LLMProviderManager } from '$src/llm/provider-manager';
import { createScenarioConfiguration } from './scenarios/knee-mri-scenario';
import type { UnifiedEvent } from '$src/types/event.types';

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
const wsUrl = wsUrlIndex !== -1 && args[wsUrlIndex + 1] 
  ? args[wsUrlIndex + 1] 
  : 'ws://localhost:3000/api/ws';

const convIndex = args.indexOf('--conversation');
const existingConversationId = convIndex !== -1 && args[convIndex + 1]
  ? parseInt(args[convIndex + 1]!, 10)
  : null;

console.log(`
╭────────────────────────────────────────────────────╮
│     Remote Scenario Agents Demo                    │
│     Knee MRI Prior Authorization                   │
├────────────────────────────────────────────────────┤
│  This demo connects agents to a remote server      │
│  via WebSocket for distributed execution.          │
│                                                    │
│  WebSocket URL: ${wsUrl!.padEnd(35)}│
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
  const rpcClient = new WsRpcClient(wsUrl!);
  
  try {
    await rpcClient.connect();
  } catch (err) {
    console.error('\n❌ Failed to connect to server at', wsUrl);
    console.error('\n💡 Make sure the server is running:');
    console.error('   bun run dev');
    console.error('\nOr specify a different URL:');
    console.error('   bun run src/cli/demo-scenario-remote.ts --ws ws://localhost:3001/api/ws');
    process.exit(1);
  }

  let conversationId: number;
  
  if (existingConversationId) {
    console.log(`\n📋 Using existing conversation ${existingConversationId}...`);
    conversationId = existingConversationId;
  } else {
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
    
    // Step 2: Create conversation on the server
    console.log('\n💬 Creating conversation on server...');
    const convResult = await rpcClient.call('createConversation', {
      meta: {
        title: 'Remote Knee MRI Prior Auth',
        scenarioId: scenarioConfig.metadata.id,
        startingAgentId: 'patient-agent',  // Patient starts the conversation
        agents: [
          { id: 'patient-agent', kind: 'external' },
          { id: 'insurance-auth-specialist', kind: 'external' }
        ]
      }
    });
    
    if (!convResult || !convResult.conversationId) {
      console.error('   ✗ Failed to create conversation');
      rpcClient.close();
      return;
    }
    
    conversationId = convResult.conversationId;
    console.log(`   ✓ Conversation ${conversationId} created`);
    
    // DEBUG: Get conversation snapshot to check scenario
    console.log('\n📸 Getting conversation snapshot...');
    const snapshotResult = await rpcClient.call('getConversationSnapshot', {
      conversationId
    });
    
    if (snapshotResult) {
      // Log the actual structure
      console.log('   conversation structure:');
      console.log('   - Has scenario:', !!snapshotResult.scenario);
      console.log('   - Scenario ID:', snapshotResult.scenario?.metadata?.id);
      console.log('   - Scenario agents:', snapshotResult.scenario?.agents?.map((a: any) => a.agentId));
      console.log('   - Conversation metadata:', JSON.stringify(snapshotResult.metadata || 'none', null, 2));
      
      if (!snapshotResult.scenario) {
        console.error('   ⚠️  WARNING: Conversation has no scenario in snapshot!');
        console.error('   This is why agents are failing.');
      } else {
        console.log('   ✓ Scenario is properly loaded');
      }
    }
  }
  
  // Step 3: Subscribe to events
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
  
  console.log(`   ✓ Subscribed (${subResult.subId})`);
  
  // Close RPC client - we'll use the agent transports from here
  rpcClient.close();
  
  // Step 4: Create provider manager
  const defaultProvider = (process.env.LLM_PROVIDER as any) || 'mock';
  const providerManager = new LLMProviderManager({
    defaultLlmProvider: defaultProvider,
    googleApiKey: process.env.GOOGLE_API_KEY,
    openRouterApiKey: process.env.OPENROUTER_API_KEY
  });
  
  console.log(`\n🤖 Starting remote agents (provider: ${defaultProvider})...`);
  
  // Step 5: Create agents with WebSocket transport
  const agents: any[] = [];
  
  // Use ScriptAgent for mock provider, ScenarioDrivenAgent for real LLMs
  const useMockScripts = defaultProvider === 'mock';
  
  // Patient agent
  const patientTransport = new WsTransport(wsUrl!);
  const patientAgent = useMockScripts 
    ? new ScriptAgent(patientTransport, patientScript)
    : new ScenarioDrivenAgent(patientTransport, {
        agentId: 'patient-agent',
        providerManager
      });
  agents.push(patientAgent);
  
  // Insurance agent
  const insuranceTransport = new WsTransport(wsUrl!);
  const insuranceAgent = useMockScripts
    ? new ScriptAgent(insuranceTransport, insuranceScript)
    : new ScenarioDrivenAgent(insuranceTransport, {
        agentId: 'insurance-auth-specialist',
        providerManager
      });
  agents.push(insuranceAgent);
  
  // Step 6: Start monitoring (separate connection for monitoring)
  const monitorWs = new WebSocket(wsUrl!);
  let messageCount = 0;
  const startTime = Date.now();
  let turnCount = 0;
  const MAX_TURNS = 20;
  
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
        console.log('\n👁️  Monitoring conversation...\n');
        console.log('─'.repeat(60));
        resolve();
      }
      
      // Handle events
      if (msg.method === 'event') {
        const event = msg.params as UnifiedEvent;
        
        if (event.type === 'message') {
          messageCount++;
          
          // Track turns (each message with finality 'turn' increments the turn count)
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
          
          // Check if we've reached the turn limit (just for monitoring)
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
            
            // Cleanup
            setTimeout(() => {
              console.log('\n🧹 Cleaning up...');
              agents.forEach(a => a.stop());
              monitorWs.close();
              patientTransport.close();
              insuranceTransport.close();
              console.log('\n✨ Demo complete!\n');
              process.exit(0);
            }, 1000);
          }
        }
      }
    };
  });
  
  // Step 7: Start the agents
  console.log('\n🚀 Starting agents...');
  await Promise.all([
    patientAgent.start(conversationId, 'patient-agent'),
    insuranceAgent.start(conversationId, 'insurance-auth-specialist')
  ]);
  console.log('   ✓ Agents started and waiting for guidance');
  
  // The conversation will start automatically via startingAgentId guidance
  console.log('\n⏳ Waiting for agents to begin conversation...\n');
  console.log('─'.repeat(60));
  
  // Keep process alive
  await new Promise(() => {});
}

// Run the demo
runDemo().catch(err => {
  console.error('\n❌ Demo failed:', err);
  process.exit(1);
});