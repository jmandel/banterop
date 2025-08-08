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
  // const wsUrl = `ws://localhost:${port}/api/ws`;
  const wsUrl = "ws://localhost:3000/api/ws";

  
  console.log(`Server started on port ${port}`);
  console.log(`WebSocket URL: ${wsUrl}`);
  console.log(`Creating conversation...`);
  
  // Create conversation via WebSocket RPC
  const { conversationId } = await rpcCall<{ conversationId: number }>(wsUrl, 'createConversation', { title: 'Simple WS Sim' });
  console.log(`Conversation ${conversationId} created\n`);

  // Simple assistant agent that responds to user
  let turnCount = 0;
  
  const assistant: Agent = {
    async handleTurn(ctx): Promise<void> {
      turnCount++;
      console.log(`[ASSISTANT] Turn ${turnCount}`);
      
      if (turnCount < 3) {
        await ctx.client.postMessage({ 
          conversationId: ctx.conversationId, 
          agentId: ctx.agentId, 
          text: `Assistant response ${turnCount}`, 
          finality: 'turn' 
        });
        
        // Simulate user continuing the conversation
        setTimeout(async () => {
          console.log(`[USER] Sending message ${turnCount + 1}`);
          await rpcCall(wsUrl, 'sendMessage', {
            conversationId,
            agentId: 'user',
            messagePayload: { text: `User message ${turnCount + 1}` },
            finality: 'turn',
          });
        }, 200);
        
        return;
      } else {
        await ctx.client.postMessage({ 
          conversationId: ctx.conversationId, 
          agentId: ctx.agentId, 
          text: 'Assistant: Goodbye!', 
          finality: 'conversation' 
        });
        return;
      }
    }
  };
  
  // Create executor - will respond to 'assistant' guidance
  const exec = new TurnLoopExecutor(assistant, {
    conversationId,
    agentId: 'assistant-1',  // Specific ID but will still respond to 'assistant' guidance
    wsUrl,
  });

  console.log('Starting assistant executor...\n');
  
  // Start executor in background
  const execPromise = exec.start().catch(err => console.error('Assistant error:', err));
  
  // Give executor time to connect and subscribe
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Now trigger the conversation with user message
  console.log('[USER] Sending initial message');
  await rpcCall(wsUrl, 'sendMessage', {
    conversationId,
    agentId: 'user',
    messagePayload: { text: 'Hello assistant!' },
    finality: 'turn',
  });
  
  try {
    // Wait for agent to complete
    await execPromise;
    console.log('\n✅ Conversation completed successfully');
  } catch (error) {
    console.error('❌ Error during simulation:', error);
  } finally {
    // Clean up
    await exec.stop();
    await appInstance.shutdown();
    server.stop(true);
    console.log('Server stopped');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});