#!/usr/bin/env bun
import { TurnLoopExecutor } from '$src/agents/executors/turn-loop.executor';
import type { Agent } from '$src/agents/agent.types';
import { App } from '$src/server/app';
import { createWebSocketServer, websocket } from '$src/server/ws/jsonrpc.server';
import { Hono } from 'hono';
import type { CreateConversationRequest } from '$src/types/conversation.meta';

// Helper for one-shot WebSocket RPC calls
async function rpcCall<T>(wsUrl: string, method: string, params?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = crypto.randomUUID();
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    ws.onmessage = (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id !== id) return;
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result as T);
    };
    ws.onerror = reject;
  });
}

async function main() {
  // Create app with guidance enabled
  const appInstance = new App({ 
    dbPath: ':memory:'
  });
  
  const honoServer = new Hono();
  honoServer.route('/', createWebSocketServer(appInstance.orchestrator));
  
  const server = Bun.serve({
    port: 0,
    fetch: honoServer.fetch,
    websocket,
  });
  
  const port = server.port;
  const wsUrl = `ws://localhost:${port}/api/ws`;
  
  console.log(`Server started on port ${port}`);
  console.log('Creating conversation with rich metadata...\n');
  
  // Create conversation with full metadata
  const createReq: CreateConversationRequest = {
    title: 'Knee MRI Prior Auth',
    description: 'ACME Health demo flow',
    scenarioId: 'prior-auth.v2',
    agents: [
      {
        id: 'patient',
        kind: 'external',
        role: 'user',
        displayName: 'Pat Doe',
        avatarUrl: 'https://example.com/patient.png',
        config: {
          language: 'en-US',
          allowedTools: ['upload-doc'],
        },
      },
      {
        id: 'insurer-assistant',
        kind: 'internal',
        role: 'assistant',
        displayName: 'Auto Reviewer Bot',
        config: {
          model: 'gpt-4o-mini',
          maxTurns: 4,
        },
      },
    ],
    config: {
      idleTurnMs: 900000,
      policy: 'strict-alternation',
    },
    custom: {
      organizationId: 'acme-health',
      tags: ['demo', 'knee', 'MRI'],
    },
  };
  
  const { conversationId } = await rpcCall<{ conversationId: number }>(wsUrl, 'createConversation', createReq);
  console.log(`Created conversation ${conversationId}\n`);
  
  // Get conversation with metadata via WebSocket RPC
  const convoWithMeta = await rpcCall<any>(wsUrl, 'getConversation', { conversationId });
  
  console.log('Conversation metadata:');
  console.log(JSON.stringify(convoWithMeta.metadata, null, 2));
  console.log();
  
  // Simple insurer assistant agent
  let turnCount = 0;
  const insurerAgent: Agent = {
    async handleTurn(ctx): Promise<void> {
      turnCount++;
      console.log(`[INSURER] Turn ${turnCount}`);
      
      if (turnCount === 1) {
        await ctx.client.postMessage({ 
          conversationId: ctx.conversationId, 
          agentId: ctx.agentId, 
          text: 'Hello! I see you need prior authorization for a knee MRI. Can you provide your member ID?', 
          finality: 'turn' 
        });
        return;
      } else if (turnCount === 2) {
        await ctx.client.postMessage({ 
          conversationId: ctx.conversationId, 
          agentId: ctx.agentId, 
          text: 'Thank you. Your prior authorization has been approved. Reference #PA-2025-1234.', 
          finality: 'conversation' 
        });
        return;
      }
    }
  };
  
  // Create executor for insurer assistant
  const exec = new TurnLoopExecutor(insurerAgent, {
    conversationId,
    agentId: 'insurer-assistant',
    wsUrl,
  });

  console.log('Starting insurer assistant executor...\n');
  
  // Start executor in background
  exec.start().catch(err => console.error('Insurer error:', err));
  
  // Give executor time to connect
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Patient sends initial message via WS RPC
  console.log('[PATIENT] Sending initial request');
  await rpcCall(wsUrl, 'sendMessage', {
    conversationId,
    agentId: 'patient',
    messagePayload: { text: 'I need prior authorization for my knee MRI scheduled next week.' },
    finality: 'turn',
  });
  
  // Wait a bit, then patient responds
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  console.log('[PATIENT] Providing member ID');
  await rpcCall(wsUrl, 'sendMessage', {
    conversationId,
    agentId: 'patient',
    messagePayload: { text: 'My member ID is ACM-123456789' },
    finality: 'turn',
  });
  
  // Wait for completion
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Get final snapshot via WS RPC
  const finalSnap = await rpcCall<any>(wsUrl, 'getConversation', { conversationId });
  
  console.log('\n=== Final Conversation ===');
  console.log('Metadata agents:', finalSnap.metadata.agents.map((a: any) => `${a.id} (${a.kind})`).join(', '));
  console.log('\nMessages:');
  for (const event of finalSnap.events) {
    if (event.type === 'message') {
      const msg = event.payload as { text: string };
      console.log(`  [${event.agentId}]: ${msg.text}`);
    }
  }
  
  console.log('\n✅ Metadata-driven conversation completed');
  
  // Clean up
  await exec.stop();
  await appInstance.shutdown();
  server.stop(true);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});