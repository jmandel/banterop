#!/usr/bin/env bun
import { TurnLoopExecutor } from '$src/agents/executors/turn-loop.executor';
import type { Agent, TurnOutcome } from '$src/agents/agent.types';
import { App } from '$src/server/app';
import { createWebSocketServer, websocket } from '$src/server/ws/jsonrpc.server';
import { createConversationRoutes } from '$src/server/routes/conversations.http';
import { Hono } from 'hono';

async function main() {
  // Create app with guidance enabled
  const appInstance = new App({ 
    dbPath: ':memory:'
  });
  
  const honoServer = new Hono();
  honoServer.route('/', createConversationRoutes(appInstance.orchestrator));
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
  const httpBase = `http://localhost:${port}`;
  
  console.log(`Server started on port ${port}`);
  console.log(`WebSocket URL: ${wsUrl}`);
  console.log(`Creating conversation...`);
  
  // Create conversation via HTTP
  const resp = await fetch(`${httpBase}/api/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Simple WS Sim' }),
  });
  
  if (!resp.ok) {
    throw new Error(`Failed to create conversation: ${resp.status}`);
  }
  
  const convo = await resp.json();
  const conversationId = convo.conversation as number;
  console.log(`Conversation ${conversationId} created\n`);

  // Simple assistant agent that responds to user
  let turnCount = 0;
  
  const assistant: Agent = {
    async handleTurn(ctx): Promise<TurnOutcome> {
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
        setTimeout(() => {
          console.log(`[USER] Sending message ${turnCount + 1}`);
          appInstance.orchestrator.appendEvent({
            conversation: conversationId,
            type: 'message',
            payload: { text: `User message ${turnCount + 1}` },
            finality: 'turn',
            agentId: 'user',
          });
        }, 200);
        
        return 'posted';
      } else {
        await ctx.client.postMessage({ 
          conversationId: ctx.conversationId, 
          agentId: ctx.agentId, 
          text: 'Assistant: Goodbye!', 
          finality: 'conversation' 
        });
        return 'complete';
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
  appInstance.orchestrator.appendEvent({
    conversation: conversationId,
    type: 'message',
    payload: { text: 'Hello assistant!' },
    finality: 'turn',
    agentId: 'user',
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