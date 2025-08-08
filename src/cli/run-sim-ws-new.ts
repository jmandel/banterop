#!/usr/bin/env bun
import { TurnLoopExecutor } from '$src/agents/executors/turn-loop.executor';
import type { Agent } from '$src/agents/agent.types';
import { App } from '$src/server/app';
import { createWebSocketServer, websocket } from '$src/server/ws/jsonrpc.server';
import { Hono } from 'hono';

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
  honoServer.get('/health', (c) => c.json({ ok: true }));
  
  // Start server on available port
  const server = Bun.serve({
    port: 0,
    fetch: honoServer.fetch,
    websocket,
  });
  
  const port = server.port;
  const wsUrl = `ws://localhost:${port}/api/ws`;
  
  console.log(`Server started on port ${port}`);
  console.log(`WebSocket URL: ${wsUrl}`);
  console.log(`Creating conversation...`);
  
  // Create conversation via WebSocket RPC
  const { conversationId } = await rpcCall<{ conversationId: number }>(wsUrl, 'createConversation', { title: 'WS Sim (New)' });
  console.log(`Conversation ${conversationId} created\n`);

  // Agent A will speak 3 times then end the conversation
  let agentATurnCount = 0;
  
  const agentA: Agent = {
    async handleTurn(ctx): Promise<void> {
      agentATurnCount++;
      console.log(`[AGENT-A] Turn ${agentATurnCount}`);
      
      if (agentATurnCount < 3) {
        await ctx.client.postMessage({ 
          conversationId: ctx.conversationId, 
          agentId: ctx.agentId, 
          text: `Agent A message ${agentATurnCount}`, 
          finality: 'turn' 
        });
        return;
      } else {
        await ctx.client.postMessage({ 
          conversationId: ctx.conversationId, 
          agentId: ctx.agentId, 
          text: 'Agent A: Ending conversation now', 
          finality: 'conversation' 
        });
        return;
      }
    }
  };

  // Agent B responds each time
  let agentBTurnCount = 0;
  const agentB: Agent = {
    async handleTurn(ctx): Promise<void> {
      agentBTurnCount++;
      console.log(`[AGENT-B] Turn ${agentBTurnCount}`);
      
      await ctx.client.postMessage({ 
        conversationId: ctx.conversationId, 
        agentId: ctx.agentId, 
        text: `Agent B message ${agentBTurnCount}`, 
        finality: 'turn' 
      });
      return;
    }
  };
  
  // Create executors using new turn-loop approach
  const execA = new TurnLoopExecutor(agentA, {
    conversationId,
    agentId: 'agent-a',
    wsUrl,
  });
  
  const execB = new TurnLoopExecutor(agentB, {
    conversationId,
    agentId: 'agent-b',
    wsUrl,
  });

  console.log('Starting agent executors...\n');
  
  // Start executors in background
  const execPromises = Promise.all([
    execA.start().catch(err => console.error('Agent A error:', err)),
    execB.start().catch(err => console.error('Agent B error:', err)),
  ]);
  
  // Give executors time to connect and subscribe
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Have both agents introduce themselves first so policy knows about them
  console.log('Agents introducing themselves...');
  await rpcCall(wsUrl, 'sendMessage', {
    conversationId,
    agentId: 'agent-a',
    messagePayload: { text: 'Agent A ready' },
    finality: 'none',  // Don't finalize turn
  });
  
  await rpcCall(wsUrl, 'sendMessage', {
    conversationId,
    agentId: 'agent-b',
    messagePayload: { text: 'Agent B ready' },
    finality: 'turn',  // Now finalize to trigger guidance
  });
  
  try {
    // Wait for agents to complete
    await execPromises;
    console.log('\n✅ Conversation completed successfully');
  } catch (error) {
    console.error('❌ Error during simulation:', error);
  } finally {
    // Clean up
    await execA.stop();
    await execB.stop();
    await appInstance.shutdown();
    server.stop(true);
    console.log('Server stopped');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});