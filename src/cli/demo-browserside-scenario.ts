#!/usr/bin/env bun

/**
 * Demo: Browser-based LLM with Scenario-driven Agents
 * 
 * This demo uses the browserside LLM provider with scenario-driven agents
 * for the knee MRI prior authorization scenario.
 * 
 * The browserside provider allows the LLM to run in the browser/client
 * while the orchestration happens on the server.
 * 
 * Usage:
 *   # Start server first: bun run server
 *   bun run src/cli/demo-browserside-scenario.ts
 *   bun run src/cli/demo-browserside-scenario.ts --ws ws://localhost:3001/api/ws
 */

import { ScenarioDrivenAgent } from '$src/agents/scenario/scenario-driven.agent';
import { WsTransport } from '$src/agents/runtime/ws.transport';
import { LLMProviderManager } from '$src/llm/provider-manager';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import kneeMriScenario from '$src/db/fixtures/knee-mri-scenario.json';
import type { UnifiedEvent } from '$src/types/event.types';

// Parse command line arguments
const args = process.argv.slice(2);
const wsUrlIndex = args.indexOf('--ws');
const wsUrl: string = (wsUrlIndex !== -1 && args[wsUrlIndex + 1]) 
  ? args[wsUrlIndex + 1]! 
  : 'ws://localhost:3000/api/ws';

// Extract server URL for browserside provider
const serverUrl = wsUrl.replace('ws://', 'http://').replace('wss://', 'https://').replace('/api/ws', '');

console.log(`
╭────────────────────────────────────────────────────╮
│     Browser-based LLM Scenario Demo                │
│     Knee MRI Prior Authorization                   │
├────────────────────────────────────────────────────┤
│  Using browserside LLM provider with               │
│  scenario-driven agents for realistic dialogue     │
│                                                    │
│  Model: gemini-2.5-flash (via browserside)         │
│  WebSocket URL: ${wsUrl.padEnd(35)}│
│  Server URL: ${serverUrl.padEnd(38)}│
╰────────────────────────────────────────────────────╯
`);

// Simple WebSocket RPC client for setup
class WsRpcClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, (result: any) => void>();
  private idCounter = 1;

  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      
      this.ws.addEventListener('open', () => {
        console.log('✓ Connected to server');
        resolve();
      });
      
      this.ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data);
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
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      });
      
      this.ws.addEventListener('error', (event) => {
        console.error('WebSocket error:', event);
        reject(event);
      });
      
      this.ws.addEventListener('close', () => {
        console.log('WebSocket closed');
      });
    });
  }
  
  async call(method: string, params: any): Promise<any> {
    return new Promise((resolve) => {
      const id = String(this.idCounter++);
      this.pending.set(id, resolve);
      
      this.ws!.send(JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id
      }));
    });
  }
  
  close() {
    this.ws?.close();
  }
}

async function main() {
  const rpc = new WsRpcClient();
  await rpc.connect(wsUrl);
  
  // Use knee MRI scenario from fixture
  const scenario = kneeMriScenario as ScenarioConfiguration;
  const scenarioId = scenario.metadata.id;
  
  // First, store the scenario in the database
  try {
    await rpc.call('createScenario', {
      id: scenarioId,
      name: scenario.metadata.title,
      config: scenario,
      history: []
    });
    console.log(`✓ Stored scenario ${scenarioId}`);
  } catch (e) {
    // Scenario might already exist, that's OK
    console.log(`ℹ Scenario ${scenarioId} may already exist`);
  }
  
  // Create conversation with the scenario ID
  const result = await rpc.call('createConversation', {
    meta: {
      title: 'Knee MRI Authorization - Browserside LLM Demo',
      scenarioId: scenarioId,  // Reference the scenario by ID
      agents: [
        { 
          id: 'patient-agent',
          displayName: 'Patient',
          config: {
            model: 'gemini-2.5-flash',
            llmProvider: 'browserside'  // Changed from 'provider' to 'llmProvider'
          }
        },
        { 
          id: 'insurance-auth-specialist',
          displayName: 'Insurance Specialist',
          config: {
            model: 'gemini-2.5-flash', 
            llmProvider: 'browserside'  // Changed from 'provider' to 'llmProvider'
          }
        }
      ],
      startingAgentId: 'patient-agent'
    }
  });
  
  const conversationId = result?.conversationId || result;
  console.log(`\n✓ Created conversation ${conversationId} with scenario`);
  
  // Create LLM provider manager configured for browserside
  const providerManager = new LLMProviderManager({
    defaultLlmProvider: 'browserside',
    defaultLlmModel: 'gemini-2.5-flash',
    serverUrl: serverUrl
  });
  
  // Create agents
  const agents = new Map<string, ScenarioDrivenAgent>();
  
  // Patient agent
  const patientTransport = new WsTransport(wsUrl);
  const patientAgent = new ScenarioDrivenAgent(patientTransport, {
    agentId: 'patient-agent',
    providerManager
  });
  agents.set('patient-agent', patientAgent);
  
  // Insurance specialist agent
  const insuranceTransport = new WsTransport(wsUrl);
  const insuranceAgent = new ScenarioDrivenAgent(insuranceTransport, {
    agentId: 'insurance-auth-specialist',
    providerManager
  });
  agents.set('insurance-auth-specialist', insuranceAgent);
  
  console.log('✓ Created scenario-driven agents with browserside LLM provider');
  
  // Start all agents
  for (const [agentId, agent] of agents) {
    await agent.start(conversationId, agentId);
    console.log(`✓ Started ${agentId}`);
  }
  
  // Subscribe to events to show the conversation
  let messageCount = 0;
  const maxMessages = 10; // Safety limit
  
  await rpc.call('subscribe', { 
    conversationId,
    types: ['message']
  });
  
  console.log('\n🎭 Starting conversation...\n');
  console.log('─'.repeat(60));
  
  // Create a WebSocket connection for events
  const eventWs = new WebSocket(wsUrl);
  let conversationEnded = false;
  
  await new Promise<void>((resolve) => {
    eventWs.addEventListener('open', () => {
      eventWs.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: { conversationId },
        id: 'sub-1'
      }));
    });
    
    eventWs.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'event') {
          const evt = msg.data as UnifiedEvent;
          
          if (evt.type === 'message') {
            messageCount++;
            const payload = evt.payload as any;
            console.log(`\n[${evt.agentId}]:`);
            console.log(`  ${payload.text}`);
            
            if (evt.finality === 'conversation' || messageCount >= maxMessages) {
              console.log('\n' + '─'.repeat(60));
              console.log('✓ Conversation completed');
              conversationEnded = true;
              setTimeout(() => resolve(), 1000);
            }
          }
        }
      } catch (e) {
        console.error('Failed to parse event:', e);
      }
    });
    
    eventWs.addEventListener('error', (event) => {
      console.error('Event WebSocket error:', event);
      resolve();
    });
    
    // Safety timeout
    setTimeout(() => {
      if (!conversationEnded) {
        console.log('\n⏱️ Demo timeout reached');
        resolve();
      }
    }, 180000); // 60 second timeout
  });
  
  // Cleanup
  for (const agent of agents.values()) {
    await agent.stop();
  }
  
  eventWs.close();
  rpc.close();
  
  console.log('\n👋 Demo completed');
  process.exit(0);
}

// Run the demo
main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});