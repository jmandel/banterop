import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MCPBridge } from './mcp.server';
import { Storage } from '../orchestrator/storage';
import { OrchestratorService } from '../orchestrator/orchestrator';
import type { MessagePayload } from '$src/types/event.types';

describe('MCPBridge', () => {
  let storage: Storage;
  let orchestrator: OrchestratorService;
  let bridge: MCPBridge;

  beforeEach(() => {
    storage = new Storage(':memory:');
    orchestrator = new OrchestratorService(storage, undefined, undefined, { 
      emitNextCandidates: true,
      idleTurnMs: 120_000 
    });
    bridge = new MCPBridge(orchestrator);
  });

  afterEach(async () => {
    await orchestrator.shutdown();
    storage.close();
  });

  describe('begin_chat_thread', () => {
    it('creates a new conversation', () => {
      const result = bridge.begin_chat_thread({ 
        title: 'Test Thread', 
        description: 'Test Description' 
      });
      
      expect(result.conversationId).toBe(1);
      expect(result.status).toBe('active');
      expect(result.latestSeq).toBe(0);
    });

    it('creates conversation without title or description', () => {
      const result = bridge.begin_chat_thread({});
      
      expect(result.conversationId).toBe(1);
      expect(result.status).toBe('active');
    });
  });

  describe('post_message', () => {
    it('posts a message with default turn finality', () => {
      const { conversationId } = bridge.begin_chat_thread({});
      
      const result = bridge.post_message({
        conversationId,
        text: 'Hello world'
      });
      
      expect(result.conversationId).toBe(conversationId);
      expect(result.turn).toBe(1);
      expect(result.event).toBe(1);
      expect(result.seq).toBeGreaterThan(0);
      expect(result.ts).toBeDefined();
      
      // Verify the message was stored
      const snapshot = orchestrator.getConversationSnapshot(conversationId);
      expect(snapshot.events.length).toBe(1);
      const event = snapshot.events[0]!;
      expect(event.type).toBe('message');
      expect((event.payload as MessagePayload).text).toBe('Hello world');
      expect(event.finality).toBe('turn');
    });

    it('posts a message with attachments', () => {
      const { conversationId } = bridge.begin_chat_thread({});
      
      const result = bridge.post_message({
        conversationId,
        text: 'See attached',
        attachments: [{
          name: 'doc.txt',
          contentType: 'text/plain',
          content: 'Document content',
          summary: 'A test document',
          docId: 'doc-123'
        }]
      });
      
      expect(result.conversationId).toBe(conversationId);
      
      const snapshot = orchestrator.getConversationSnapshot(conversationId);
      const payload = snapshot.events[0]!.payload as MessagePayload;
      expect(payload.attachments).toBeDefined();
      expect(payload.attachments![0]!.id).toMatch(/^att_/);
      expect(payload.attachments![0]!.name).toBe('doc.txt');
      expect(payload.attachments![0]!.docId).toBe('doc-123');
    });

    it('handles idempotent requests with clientRequestId', () => {
      const { conversationId } = bridge.begin_chat_thread({});
      
      const first = bridge.post_message({
        conversationId,
        text: 'Test message',
        clientRequestId: 'req-123'
      });
      
      const second = bridge.post_message({
        conversationId,
        text: 'Test message',
        clientRequestId: 'req-123'
      });
      
      expect(second.seq).toBe(first.seq);
      expect(second.turn).toBe(first.turn);
      expect(second.event).toBe(first.event);
      
      // Should only have one event
      const snapshot = orchestrator.getConversationSnapshot(conversationId);
      expect(snapshot.events.length).toBe(1);
    });

    it('posts with custom finality', () => {
      const { conversationId } = bridge.begin_chat_thread({});
      
      bridge.post_message({
        conversationId,
        text: 'Final message',
        finality: 'conversation'
      });
      
      const snapshot = orchestrator.getConversationSnapshot(conversationId);
      expect(snapshot.events[0]!.finality).toBe('conversation');
      expect(snapshot.status).toBe('completed');
    });
  });

  describe('wait_for_updates', () => {
    it('returns immediately when no timeout is specified', async () => {
      const { conversationId } = bridge.begin_chat_thread({});
      
      bridge.post_message({
        conversationId,
        text: 'Initial message'
      });
      
      const result = await bridge.wait_for_updates({
        conversationId,
        timeoutMs: 0
      });
      
      expect(result.timedOut).toBe(false);
      expect(result.messages.length).toBe(1);
      expect(result.messages[0]!.text).toBe('Initial message');
      expect(result.guidance).toBe('you_may_speak');
    });

    it('filters messages by sinceSeq', async () => {
      const { conversationId } = bridge.begin_chat_thread({});
      
      const msg1 = bridge.post_message({
        conversationId,
        text: 'First'
      });
      
      bridge.post_message({
        conversationId,
        text: 'Second'
      });
      
      const result = await bridge.wait_for_updates({
        conversationId,
        sinceSeq: msg1.seq,
        timeoutMs: 0
      });
      
      expect(result.messages.length).toBe(1);
      expect(result.messages[0]!.text).toBe('Second');
    });

    it('respects limit parameter', async () => {
      const { conversationId } = bridge.begin_chat_thread({});
      
      for (let i = 1; i <= 5; i++) {
        bridge.post_message({
          conversationId,
          text: `Message ${i}`
        });
      }
      
      const result = await bridge.wait_for_updates({
        conversationId,
        limit: 2,
        timeoutMs: 0
      });
      
      expect(result.messages.length).toBe(2);
      expect(result.messages[0]!.text).toBe('Message 1');
      expect(result.messages[1]!.text).toBe('Message 2');
    });

    it('returns guidance based on conversation state', async () => {
      const { conversationId } = bridge.begin_chat_thread({});
      
      // No messages - should be able to speak
      let result = await bridge.wait_for_updates({
        conversationId,
        timeoutMs: 0
      });
      expect(result.guidance).toBe('you_may_speak');
      
      // Message with turn finality - should be able to speak
      bridge.post_message({
        conversationId,
        text: 'Turn complete',
        finality: 'turn'
      });
      
      result = await bridge.wait_for_updates({
        conversationId,
        timeoutMs: 0
      });
      expect(result.guidance).toBe('you_may_speak');
      
      // Message with no finality - should wait
      bridge.post_message({
        conversationId,
        text: 'Still working',
        finality: 'none'
      });
      
      result = await bridge.wait_for_updates({
        conversationId,
        timeoutMs: 0
      });
      expect(result.guidance).toBe('wait');
      expect(result.note).toContain('external-mcp is still working');
      
      // Conversation finalized - should be closed
      bridge.post_message({
        conversationId,
        text: 'Done',
        finality: 'conversation'
      });
      
      result = await bridge.wait_for_updates({
        conversationId,
        timeoutMs: 0
      });
      expect(result.guidance).toBe('closed');
      expect(result.status).toBe('completed');
    });

    it('waits for updates with timeout', async () => {
      const { conversationId } = bridge.begin_chat_thread({});
      
      bridge.post_message({
        conversationId,
        text: 'Initial',
        finality: 'none' // Keep turn open
      });
      
      const startTime = Date.now();
      const result = await bridge.wait_for_updates({
        conversationId,
        timeoutMs: 100 // Short timeout for testing
      });
      const elapsed = Date.now() - startTime;
      
      expect(result.timedOut).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(elapsed).toBeLessThan(200); // Should not wait much longer
    });

    it('returns immediately when new events arrive', async () => {
      const { conversationId } = bridge.begin_chat_thread({});
      
      bridge.post_message({
        conversationId,
        text: 'Initial',
        finality: 'none'
      });
      
      const initialSeq = orchestrator.getConversationSnapshot(conversationId).events[0]!.seq;
      
      // Start waiting in background
      const waitPromise = bridge.wait_for_updates({
        conversationId,
        sinceSeq: initialSeq,
        timeoutMs: 5000 // Long timeout
      });
      
      // Post a new message after a short delay
      setTimeout(() => {
        bridge.post_message({
          conversationId,
          text: 'New message',
          finality: 'turn'
        });
      }, 50);
      
      const startTime = Date.now();
      const result = await waitPromise;
      const elapsed = Date.now() - startTime;
      
      expect(result.timedOut).toBe(false);
      expect(elapsed).toBeLessThan(500); // Should return quickly after message
      expect(result.messages.length).toBeGreaterThan(0);
    });

    it('converts message payloads to public format', async () => {
      const { conversationId } = bridge.begin_chat_thread({});
      
      bridge.post_message({
        conversationId,
        text: 'Test message',
        attachments: [{
          name: 'file.txt',
          contentType: 'text/plain',
          content: 'content',
          summary: 'Test file',
          docId: 'doc-456'
        }]
      });
      
      const result = await bridge.wait_for_updates({
        conversationId,
        timeoutMs: 0
      });
      
      const msg = result.messages[0]!;
      expect(msg.conversationId).toBe(conversationId);
      expect(msg.text).toBe('Test message');
      expect(msg.agentId).toBe('external-mcp');
      expect(msg.finality).toBe('turn');
      expect(msg.attachments).toBeDefined();
      expect(msg.attachments![0]!.id).toMatch(/^att_/);
      expect(msg.attachments![0]!.name).toBe('file.txt');
      expect(msg.attachments![0]!.docId).toBe('doc-456');
      expect(msg.attachments![0]!.summary).toBe('Test file');
    });
  });

  describe('integration with orchestrator events', () => {
    it('receives events from other agents', async () => {
      const { conversationId } = bridge.begin_chat_thread({});
      
      // External agent posts message
      bridge.post_message({
        conversationId,
        text: 'Hello from external'
      });
      
      // Internal agent responds directly through orchestrator
      orchestrator.sendMessage(
        conversationId,
        'internal-agent',
        { text: 'Hello from internal' },
        'turn'
      );
      
      const result = await bridge.wait_for_updates({
        conversationId,
        timeoutMs: 0
      });
      
      expect(result.messages.length).toBe(2);
      expect(result.messages[0]!.agentId).toBe('external-mcp');
      expect(result.messages[1]!.agentId).toBe('internal-agent');
    });
  });
});