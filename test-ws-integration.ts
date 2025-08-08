#!/usr/bin/env bun
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { App } from './src/server/app';
import { TurnLoopExecutor } from './src/agents/executors/turn-loop.executor';
import { EchoAgent } from './src/agents/echo.agent';
import { createWebSocketServer, websocket } from './src/server/ws/jsonrpc.server';
import { createConversationRoutes } from './src/server/routes/conversations.http';
import { Hono } from 'hono';

describe('WebSocket Integration', () => {
  let app: App;
  let server: any;
  let wsUrl: string;
  let httpBase: string;

  beforeAll(async () => {
    // Start server with guidance enabled
    app = new App({ 
      dbPath: ':memory:', 
      emitGuidance: true,
      emitNextCandidates: false 
    });
    
    const honoServer = new Hono();
    honoServer.route('/', createConversationRoutes(app.orchestrator));
    honoServer.route('/', createWebSocketServer(app.orchestrator));
    
    server = Bun.serve({
      port: 0,
      fetch: honoServer.fetch,
      websocket,
    });
    
    wsUrl = `ws://localhost:${server.port}/api/ws`;
    httpBase = `http://localhost:${server.port}`;
    
    console.log(`Test server on port ${server.port}`);
  });

  afterAll(async () => {
    await app.shutdown();
    server.stop(true);
  });

  it('agents respond to guidance over WebSocket', async () => {
    // First, let's see what guidance is emitted
    const guidanceReceived: any[] = [];
    app.orchestrator.subscribe(1, (e: any) => {
      if (e.type === 'guidance') {
        console.log('Guidance emitted:', e);
        guidanceReceived.push(e);
      }
    }, true);
    // Create conversation
    const resp = await fetch(`${httpBase}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'WS Test' }),
    });
    
    const convo = await resp.json();
    const conversationId = convo.conversation as number;
    console.log(`Created conversation ${conversationId}`);
    
    // Track what happens
    const events: string[] = [];
    
    // Create a simple agent that just logs
    const testAgent = new EchoAgent('Thinking...', 'Response!');
    
    const executor = new TurnLoopExecutor(testAgent, {
      conversationId,
      agentId: 'test-agent',
      wsUrl,
    });
    
    // Start executor in background
    const execTask = executor.start().catch(err => {
      console.error('Executor error:', err);
    });
    
    // Give executor time to connect and subscribe
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Now trigger the conversation - THIS is what was missing!
    console.log('Triggering conversation with user message...');
    app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'Hello agent' },
      finality: 'turn',
      agentId: 'user',
    });
    
    // Wait for agent to respond
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check what happened
    const snapshot = app.orchestrator.getConversationSnapshot(conversationId);
    const messages = snapshot.events
      .filter(e => e.type === 'message')
      .map(e => `${e.agentId}: ${(e.payload as any).text}`);
    
    console.log('Messages:', messages);
    
    // End conversation
    app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'Goodbye' },
      finality: 'conversation',
      agentId: 'user',
    });
    
    // Wait for executor to stop
    await Promise.race([
      execTask,
      new Promise(resolve => setTimeout(resolve, 1000))
    ]);
    
    await executor.stop();
    
    // Verify agent responded
    expect(messages.length).toBeGreaterThanOrEqual(3); // user, agent thinking, agent response
    expect(messages.some(m => m.includes('test-agent'))).toBe(true);
  });
});