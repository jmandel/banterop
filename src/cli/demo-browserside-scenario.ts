#!/usr/bin/env bun

/**
 * Demo: Client-managed agents with control + transport
 *
 * - Uses WsControl to create a conversation
 * - Runs agents locally via startAgents + WsTransport
 * - Streams events via WsEventStream
 * - LLM provider: browserside (Gemini) with server proxy URL derived from wsUrl
 *
 * Usage:
 *   bun run src/cli/demo-browserside-scenario.ts [--ws ws://localhost:3001/api/ws]
 */

import { startAgents } from '$src/agents/factories/agent.factory';
import { WsTransport } from '$src/agents/runtime/ws.transport';
import { LLMProviderManager } from '$src/llm/provider-manager';
import type { UnifiedEvent } from '$src/types/event.types';
import { WsEventStream } from '$src/agents/clients/event-stream';
import { WsControl } from '$src/control/ws.control';

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
│     Client-Managed Agents Demo                     │
│     Knee MRI Prior Authorization                   │
├────────────────────────────────────────────────────┤
│  Control: WsControl                                │
│  Data: startAgents + WsTransport                   │
│  LLM: browserside (Gemini)                         │
│  WS URL: ${wsUrl.padEnd(41)}│
│  HTTP URL: ${serverUrl.padEnd(39)}│
╰────────────────────────────────────────────────────╯
`);
async function main() {
  // Control plane
  const control = new WsControl(wsUrl);

  // Create conversation that matches seeded scenario agents
  const conversationId = await control.createConversation({
    title: 'Knee MRI Authorization - Browserside LLM Demo',
    scenarioId: 'scen_knee_mri_01',
    startingAgentId: 'patient-agent',
    agents: [
      { id: 'patient-agent', displayName: 'Patient' },
      { id: 'insurance-auth-specialist', displayName: 'Insurance Specialist' },
    ],
  } as any);

  console.log(`\n✓ Created conversation ${conversationId}`);

  // Local agents over WS transport
  const providerManager = new LLMProviderManager({
    defaultLlmProvider: 'browserside',
    defaultLlmModel: 'gemini-2.5-flash',
    serverUrl,
  });

  const handle = await startAgents({
    conversationId,
    transport: new WsTransport(wsUrl),
    providerManager,
    turnRecoveryMode: 'restart',
  });

  // Stream and show messages
  let messageCount = 0;
  const maxMessages = 10;
  const stream = new WsEventStream(wsUrl, { conversationId, includeGuidance: false });

  console.log('\n🎭 Starting conversation...\n');
  console.log('─'.repeat(60));

  for await (const ev of stream) {
    if ('type' in ev && ev.type === 'message') {
      const evt = ev as UnifiedEvent;
      messageCount++;
      console.log(`\n[${evt.agentId}]:`);
      console.log(`  ${(evt.payload as any).text}`);
      if (evt.finality === 'conversation' || messageCount >= maxMessages) {
        console.log('\n' + '─'.repeat(60));
        console.log('✓ Conversation completed');
        break;
      }
    }
  }

  await handle.stop();
  console.log('\n👋 Demo completed');
  process.exit(0);
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
