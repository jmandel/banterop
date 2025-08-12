import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { WsEventStream, InProcessEventStream } from './event-stream';
import type { UnifiedEvent } from '$src/types/event.types';
import type { GuidanceEvent } from '$src/types/orchestrator.types';

describe('InProcessEventStream', () => {
  let mockOrchestrator: any;
  let listeners: Map<string, (e: any) => void>;
  
  beforeEach(() => {
    listeners = new Map();
    mockOrchestrator = {
      subscribe: mock((_convId: number, listener: (e: any) => void, _includeGuidance: boolean) => {
        const subId = `sub-${Math.random()}`;
        listeners.set(subId, listener);
        return subId;
      }),
      unsubscribe: mock((subId: string) => {
        listeners.delete(subId);
      }),
    };
  });
  
  test('subscribes and receives events', async () => {
    const stream = new InProcessEventStream(mockOrchestrator, {
      conversationId: 1,
      includeGuidance: false,
    });
    
    const events: any[] = [];
    
    // Start consuming events in background
    const consumePromise = (async () => {
      for await (const event of stream) {
        events.push(event);
        if (events.length >= 2) break;
      }
    })();
    
    // Emit some events
    const listener = listeners.values().next().value!;
    const event1: UnifiedEvent = {
      conversation: 1,
      turn: 1,
      event: 1,
      type: 'message',
      payload: { text: 'Hello' },
      finality: 'none',
      ts: new Date().toISOString(),
      agentId: 'test',
      seq: 1,
    };
    listener(event1);
    
    const event2: UnifiedEvent = {
      conversation: 1,
      turn: 1,
      event: 2,
      type: 'message',
      payload: { text: 'World' },
      finality: 'turn',
      ts: new Date().toISOString(),
      agentId: 'test',
      seq: 2,
    };
    listener(event2);
    
    await consumePromise;
    
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(event1);
    expect(events[1]).toEqual(event2);
    expect(mockOrchestrator.subscribe).toHaveBeenCalledWith(1, expect.any(Function), false);
  });
  
  test('receives guidance events when enabled', async () => {
    const stream = new InProcessEventStream(mockOrchestrator, {
      conversationId: 1,
      includeGuidance: true,
    });
    
    const events: any[] = [];
    const consumePromise = (async () => {
      for await (const event of stream) {
        events.push(event);
        if (events.length >= 2) break;
      }
    })();
    
    const listener = listeners.values().next().value!;
    
    const guidanceEvent: GuidanceEvent = {
      type: 'guidance',
      conversation: 1,
      seq: 1.1,
      nextAgentId: 'agent-a',
      kind: 'start_turn',
      deadlineMs: 30000,
    };
    listener(guidanceEvent);
    
    const messageEvent: UnifiedEvent = {
      conversation: 1,
      turn: 1,
      event: 1,
      type: 'message',
      payload: { text: 'Response' },
      finality: 'turn',
      ts: new Date().toISOString(),
      agentId: 'agent-a',
      seq: 2,
    };
    listener(messageEvent);
    
    await consumePromise;
    
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(guidanceEvent);
    expect(events[1]).toEqual(messageEvent);
    expect(mockOrchestrator.subscribe).toHaveBeenCalledWith(1, expect.any(Function), true);
  });
  
  test('automatically closes on conversation finality', async () => {
    const stream = new InProcessEventStream(mockOrchestrator, {
      conversationId: 1,
    });
    
    const events: any[] = [];
    const consumePromise = (async () => {
      for await (const event of stream) {
        events.push(event);
      }
    })();
    
    const listener = listeners.values().next().value!;
    
    const finalEvent: UnifiedEvent = {
      conversation: 1,
      turn: 1,
      event: 1,
      type: 'message',
      payload: { text: 'Goodbye' },
      finality: 'conversation',
      ts: new Date().toISOString(),
      agentId: 'test',
      seq: 1,
    };
    listener(finalEvent);
    
    await consumePromise;
    
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(finalEvent);
    expect(mockOrchestrator.unsubscribe).toHaveBeenCalled();
  });
  
  test('handles close() correctly', async () => {
    const stream = new InProcessEventStream(mockOrchestrator, {
      conversationId: 1,
    });
    
    const iterator = stream[Symbol.asyncIterator]();
    const nextPromise = iterator.next();
    
    // Close the stream
    stream.close();
    
    const result = await nextPromise;
    expect(result.done).toBe(true);
    expect(mockOrchestrator.unsubscribe).toHaveBeenCalled();
  });
});

describe('WsEventStream', () => {
  let mockWebSocket: any;
  let wsInstances: any[] = [];
  let originalWebSocket: any;
  let originalCrypto: any;
  
  beforeEach(() => {
    wsInstances = [];
    originalWebSocket = global.WebSocket;
    originalCrypto = global.crypto;
    
    // Mock crypto.randomUUID
    global.crypto = {
      randomUUID: () => `uuid-${Math.random()}`,
    } as any;
    
    // Mock WebSocket globally
    global.WebSocket = class MockWebSocket {
      url: string;
      readyState: number;
      send: any;
      close: any;
      onopen: any;
      onmessage: any;
      onclose: any;
      onerror: any;
      
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      
      constructor(url: string) {
        this.url = url;
        this.readyState = 0; // CONNECTING
        this.send = mock(() => {});
        this.close = mock(() => {
          this.readyState = 3; // CLOSED
        });
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        
        mockWebSocket = this;
        wsInstances.push(this);
        
        // Simulate connection opening
        setTimeout(() => {
          if (this.readyState === 0) {
            this.readyState = 1; // OPEN
            if (this.onopen) {
              this.onopen();
            }
          }
        }, 5);
      }
    } as any;
  });
  
  afterEach(() => {
    wsInstances = [];
    global.WebSocket = originalWebSocket;
    global.crypto = originalCrypto;
  });
  
  test('connects and subscribes to events', async () => {
    const stream = new WsEventStream('ws://localhost:3000', {
      conversationId: 1,
      includeGuidance: true,
    });
    
    // Start iteration to trigger connection
    const iterator = stream[Symbol.asyncIterator]();
    void iterator.next();
    
    // Wait for connection
    await new Promise(resolve => setTimeout(resolve, 20));
    
    // Verify subscription message was sent
    expect(mockWebSocket.send).toHaveBeenCalled();
    const sentMessages = mockWebSocket.send.mock.calls.map((call: any[]) => JSON.parse(call[0]));
    const subMessage = sentMessages.find((msg: any) => msg.method === 'subscribe');
    
    expect(subMessage).toBeDefined();
    expect(subMessage.params).toEqual({
      conversationId: 1,
      includeGuidance: true,
    });
    
    stream.close();
  });
  
  test('receives and queues events', async () => {
    const stream = new WsEventStream('ws://localhost:3000', {
      conversationId: 1,
    });
    
    const events: any[] = [];
    const consumePromise = (async () => {
      for await (const event of stream) {
        events.push(event);
        if (events.length >= 2) break;
      }
    })();
    
    // Wait for connection
    await new Promise(resolve => setTimeout(resolve, 20));
    
    // Simulate receiving subscription response
    mockWebSocket.onmessage({
      data: JSON.stringify({
        id: 'sub-req-id',
        result: { subId: 'subscription-123' },
      }),
    });
    
    // Simulate receiving events
    const event1: UnifiedEvent = {
      conversation: 1,
      turn: 1,
      event: 1,
      type: 'message',
      payload: { text: 'First' },
      finality: 'none',
      ts: new Date().toISOString(),
      agentId: 'test',
      seq: 1,
    };
    
    mockWebSocket.onmessage({
      data: JSON.stringify({
        method: 'event',
        params: event1,
      }),
    });
    
    const guidanceEvent: GuidanceEvent = {
      type: 'guidance',
      conversation: 1,
      seq: 1.1,
      nextAgentId: 'agent-a',
      kind: 'start_turn',
    };
    
    mockWebSocket.onmessage({
      data: JSON.stringify({
        method: 'guidance',
        params: guidanceEvent,
      }),
    });
    
    await consumePromise;
    
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(event1);
    expect(events[1]).toEqual(guidanceEvent);
    
    stream.close();
  });
  
  test('sends heartbeat pings', async () => {
    const stream = new WsEventStream('ws://localhost:3000', {
      conversationId: 1,
      heartbeatIntervalMs: 50,
    });
    
    // Start iteration to trigger connection
    const iterator = stream[Symbol.asyncIterator]();
    void iterator.next();
    
    // Wait for connection
    await new Promise(resolve => setTimeout(resolve, 20));
    
    // Wait for heartbeat
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const sentMessages = mockWebSocket.send.mock.calls.map((call: any[]) => JSON.parse(call[0]));
    const pingMessage = sentMessages.find((msg: any) => msg.method === 'ping');
    
    expect(pingMessage).toBeDefined();
    expect(pingMessage.jsonrpc).toBe('2.0');
    
    stream.close();
  });
  
  test('reconnects on connection loss', async () => {
    const stream = new WsEventStream('ws://localhost:3000', {
      conversationId: 1,
      reconnectDelayMs: 50,
    });
    
    // Start iteration to trigger connection
    const iterator = stream[Symbol.asyncIterator]();
    void iterator.next();
    
    // Wait for initial connection
    await new Promise(resolve => setTimeout(resolve, 20));
    
    const firstWs = mockWebSocket;
    expect(wsInstances).toHaveLength(1);
    
    // Simulate connection loss
    mockWebSocket.readyState = 3; // CLOSED
    mockWebSocket.onclose();
    
    // Wait for reconnection
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Should have created a new WebSocket
    expect(wsInstances.length).toBeGreaterThan(1);
    expect(wsInstances[wsInstances.length - 1]).not.toBe(firstWs);
    
    stream.close();
  });
  
  test('closes on conversation end', async () => {
    const stream = new WsEventStream('ws://localhost:3000', {
      conversationId: 1,
    });
    
    const events: any[] = [];
    const consumePromise = (async () => {
      for await (const event of stream) {
        events.push(event);
      }
    })();
    
    // Wait for connection
    await new Promise(resolve => setTimeout(resolve, 20));
    
    // First, simulate receiving subscription response with subId
    const subMessages = mockWebSocket.send.mock.calls.map((call: any[]) => JSON.parse(call[0]));
    const subRequest = subMessages.find((msg: any) => msg.method === 'subscribe');
    if (subRequest) {
      mockWebSocket.onmessage({
        data: JSON.stringify({
          id: subRequest.id,
          result: { subId: 'test-sub-123' },
        }),
      });
    }
    
    // Send conversation-ending event
    const finalEvent: UnifiedEvent = {
      conversation: 1,
      turn: 1,
      event: 1,
      type: 'message',
      payload: { text: 'Done' },
      finality: 'conversation',
      ts: new Date().toISOString(),
      agentId: 'test',
      seq: 1,
    };
    
    mockWebSocket.onmessage({
      data: JSON.stringify({
        method: 'event',
        params: finalEvent,
      }),
    });
    
    await consumePromise;
    
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(finalEvent);
    
    // Should have sent unsubscribe message
    const sentMessages = mockWebSocket.send.mock.calls.map((call: any[]) => JSON.parse(call[0]));
    const unsubMessage = sentMessages.find((msg: any) => msg.method === 'unsubscribe');
    expect(unsubMessage).toBeDefined();
    expect(unsubMessage.params.subId).toBe('test-sub-123');
  });
  
  test('handles close() with cleanup', async () => {
    const stream = new WsEventStream('ws://localhost:3000', {
      conversationId: 1,
    });
    
    // Start iteration to trigger connection
    const iterator = stream[Symbol.asyncIterator]();
    void iterator.next();
    
    // Wait for connection
    await new Promise(resolve => setTimeout(resolve, 20));
    
    // Get the subscription request ID
    const subMessages = mockWebSocket.send.mock.calls.map((call: any[]) => JSON.parse(call[0]));
    const subRequest = subMessages.find((msg: any) => msg.method === 'subscribe');
    
    // Set subscription ID
    if (subRequest) {
      mockWebSocket.onmessage({
        data: JSON.stringify({
          id: subRequest.id,
          result: { subId: 'sub-123' },
        }),
      });
    }
    
    // Wait a bit for subId to be stored
    await new Promise(resolve => setTimeout(resolve, 10));
    
    stream.close();
    
    // Should have sent unsubscribe
    const allMessages = mockWebSocket.send.mock.calls.map((call: any[]) => JSON.parse(call[0]));
    const unsubMessage = allMessages.find((msg: any) => msg.method === 'unsubscribe');
    expect(unsubMessage).toBeDefined();
    expect(unsubMessage?.params?.subId).toBe('sub-123');
    
    // WebSocket should be closed
    expect(mockWebSocket.close).toHaveBeenCalled();
  });
});
