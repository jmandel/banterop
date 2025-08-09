import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { WsEventStream } from './event-stream';
import { App } from '$src/server/app';
import { createWebSocketServer, websocket } from '$src/server/ws/jsonrpc.server';
import { Hono } from 'hono';
import type { UnifiedEvent } from '$src/types/event.types';
import type { GuidanceEvent } from '$src/types/orchestrator.types';

describe('WsEventStream Integration Tests', () => {
  let app: App;
  let server: any;
  let port: number;
  let wsUrl: string;
  let conversationId: number;

  beforeEach(async () => {
    // Create real server with WebSocket support
    app = new App({ dbPath: ':memory:' });
    
    const honoServer = new Hono();
    honoServer.route('/', createWebSocketServer(app.orchestrator));
    
    server = Bun.serve({
      port: 0, // Random port
      fetch: honoServer.fetch,
      websocket,
    });
    
    port = server.port;
    wsUrl = `ws://localhost:${port}/api/ws`;
    
    // Create a test conversation with configured agents
    conversationId = app.orchestrator.createConversation({
      meta: {
        title: 'Test Conversation',
        agents: [
          { id: 'user' },
          { id: 'test-agent' },
        ],
      },
    });
  });

  afterEach(async () => {
    server.stop();
    await app.shutdown();
  });

  test('connects and receives events', async () => {
    const stream = new WsEventStream(wsUrl, {
      conversationId,
      includeGuidance: false,
    });

    const receivedEvents: UnifiedEvent[] = [];
    
    // Start consuming events in background
    const consumePromise = (async () => {
      for await (const event of stream) {
        if ('type' in event && event.type === 'message') {
          receivedEvents.push(event as UnifiedEvent);
          if (receivedEvents.length >= 2) break;
        }
      }
    })();

    // Give stream time to connect
    await new Promise(resolve => setTimeout(resolve, 50));

    // Post some events through the orchestrator
    app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'First message' },
      finality: 'none',
      agentId: 'test-agent',
    });

    app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'Second message' },
      finality: 'turn',
      agentId: 'test-agent',
    });

    // Wait for events to be consumed
    await Promise.race([
      consumePromise,
      new Promise(resolve => setTimeout(resolve, 500)),
    ]);

    expect(receivedEvents).toHaveLength(2);
    expect(receivedEvents[0]?.payload).toEqual({ text: 'First message' });
    expect(receivedEvents[1]?.payload).toEqual({ text: 'Second message' });
    
    stream.close();
  });

  test('receives guidance events when enabled', async () => {
    const stream = new WsEventStream(wsUrl, {
      conversationId,
      includeGuidance: true,
    });

    const receivedEvents: any[] = [];
    
    // Start consuming events
    void (async () => {
      for await (const event of stream) {
        receivedEvents.push(event);
        if (receivedEvents.length >= 2) break;
      }
    })();

    // Give stream time to connect
    await new Promise(resolve => setTimeout(resolve, 50));

    // Post a message that will trigger guidance
    app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'User message' },
      finality: 'turn',
      agentId: 'user',
    });

    // Wait a bit for guidance to be emitted
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check we got both the message and guidance
    const messages = receivedEvents.filter(e => e.type === 'message');
    const guidance = receivedEvents.filter(e => e.type === 'guidance');
    
    expect(messages.length).toBeGreaterThan(0);
    expect(guidance.length).toBeGreaterThan(0);
    
    const guidanceEvent = guidance[0] as GuidanceEvent;
    expect(guidanceEvent.conversation).toBe(conversationId);
    expect(guidanceEvent.nextAgentId).toBeDefined();
    
    stream.close();
  });

  test('automatically closes on conversation end', async () => {
    const stream = new WsEventStream(wsUrl, {
      conversationId,
    });

    const receivedEvents: UnifiedEvent[] = [];
    let streamEnded = false;
    
    // Consume all events
    const consumePromise = (async () => {
      for await (const event of stream) {
        if ('type' in event) {
          receivedEvents.push(event as UnifiedEvent);
        }
      }
      streamEnded = true;
    })();

    // Give stream time to connect
    await new Promise(resolve => setTimeout(resolve, 50));

    // Post conversation-ending message
    app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'Goodbye' },
      finality: 'conversation',
      agentId: 'test-agent',
    });

    // Wait for stream to end
    await Promise.race([
      consumePromise,
      new Promise(resolve => setTimeout(resolve, 500)),
    ]);

    expect(streamEnded).toBe(true);
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]?.finality).toBe('conversation');
  });

  test('handles multiple concurrent streams', async () => {
    const stream1 = new WsEventStream(wsUrl, {
      conversationId,
    });
    
    const stream2 = new WsEventStream(wsUrl, {
      conversationId,
    });

    const events1: any[] = [];
    const events2: any[] = [];

    // Start both streams
    const consume1 = (async () => {
      for await (const event of stream1) {
        if ('type' in event && event.type === 'message') {
          events1.push(event);
          if (events1.length >= 1) break;
        }
      }
    })();

    const consume2 = (async () => {
      for await (const event of stream2) {
        if ('type' in event && event.type === 'message') {
          events2.push(event);
          if (events2.length >= 1) break;
        }
      }
    })();

    // Give streams time to connect
    await new Promise(resolve => setTimeout(resolve, 50));

    // Post an event
    app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'Broadcast message' },
      finality: 'turn',
      agentId: 'test-agent',
    });

    // Wait for both streams to receive
    await Promise.all([
      Promise.race([consume1, new Promise(resolve => setTimeout(resolve, 500))]),
      Promise.race([consume2, new Promise(resolve => setTimeout(resolve, 500))]),
    ]);

    // Both streams should receive the same event
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
    expect(events1[0].payload).toEqual({ text: 'Broadcast message' });
    expect(events2[0].payload).toEqual({ text: 'Broadcast message' });

    stream1.close();
    stream2.close();
  });

  test('subscribe with filters and sinceSeq backlog', async () => {
    // Post some seed events by different agents
    app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'from A1' },
      finality: 'none',
      agentId: 'agent-A',
    });
    const lastA1 = app.orchestrator.getConversationSnapshot(conversationId).events.slice(-1)[0]!.seq;

    app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'from B1' },
      finality: 'none',
      agentId: 'agent-B',
    });

    // Subscribe to only agent-B messages and replay from before B1 (so we get B1)
    const stream = new WsEventStream(wsUrl, {
      conversationId,
      filters: { types: ['message'], agents: ['agent-B'] },
      sinceSeq: lastA1, // > lastA1 means include B1
    });

    const received: any[] = [];
    const consuming = (async () => {
      for await (const ev of stream) {
        received.push(ev);
        if (received.length >= 2) break; // expect 1 backlog (B1) and 1 live
      }
    })();

    // Allow connection to establish and backlog to arrive
    await new Promise((r) => setTimeout(r, 100));

    // Now post live events for A and B; only B should be delivered due to filters
    app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'from A2' },
      finality: 'none',
      agentId: 'agent-A',
    });
    app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'from B2' },
      finality: 'turn',
      agentId: 'agent-B',
    });

    await Promise.race([consuming, new Promise((r) => setTimeout(r, 1000))]);

    // Verify we got the backlog (B1) and live (B2), only message type, only agent-B
    const msgs = received.filter((e) => e.type === 'message');
    expect(msgs.length).toBe(2);
    expect(msgs[0]?.agentId).toBe('agent-B');
    expect((msgs[0]?.payload as any).text).toBe('from B1');
    expect(msgs[1]?.agentId).toBe('agent-B');
    expect((msgs[1]?.payload as any).text).toBe('from B2');

    stream.close();
  });

  test('reconnects after connection loss', async () => {
    const stream = new WsEventStream(wsUrl, {
      conversationId,
      reconnectDelayMs: 100,
    });

    const receivedEvents: any[] = [];
    
    // Start consuming
    const consumePromise = (async () => {
      for await (const event of stream) {
        if ('type' in event && event.type === 'message') {
          receivedEvents.push(event);
          if (receivedEvents.length >= 2) break;
        }
      }
    })();

    // Give stream time to connect
    await new Promise(resolve => setTimeout(resolve, 50));

    // Post first event
    app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'Before disconnect' },
      finality: 'turn',
      agentId: 'test-agent',
    });

    // Wait for event to be received
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(receivedEvents).toHaveLength(1);

    // Simulate connection loss by stopping and restarting server
    const oldPort = port;
    server.stop();
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Restart server on same port
    const honoServer2 = new Hono();
    honoServer2.route('/', createWebSocketServer(app.orchestrator));
    server = Bun.serve({
      port: oldPort,
      fetch: honoServer2.fetch,
      websocket,
    });

    // Wait for reconnection
    await new Promise(resolve => setTimeout(resolve, 200));

    // Get the lastClosedSeq for precondition
    const snapshot = app.orchestrator.getConversationSnapshot(conversationId);
    
    // Post another event
    app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'After reconnect' },
      finality: 'turn',
      agentId: 'test-agent'
    });

    // Wait for consumption
    await Promise.race([
      consumePromise,
      new Promise(resolve => setTimeout(resolve, 500)),
    ]);

    // Should have received both events
    expect(receivedEvents).toHaveLength(2);
    expect(receivedEvents[0].payload).toEqual({ text: 'Before disconnect' });
    expect(receivedEvents[1].payload).toEqual({ text: 'After reconnect' });

    stream.close();
  });
});