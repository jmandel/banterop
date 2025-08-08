import { describe, it, expect } from 'bun:test';
import { App } from './app';
import type { MessagePayload } from '$src/types/event.types';

describe('App integration', () => {
  it('uses :memory: database for tests', async () => {
    const app = new App({ dbPath: ':memory:' });
    
    // Create a conversation
    const conversationId = app.orchestrator.createConversation({
      title: 'Test conversation',
      description: 'Testing in-memory db'
    });
    
    expect(conversationId).toBe(1);
    
    // Add an event
    const result = app.orchestrator.appendEvent({
      conversation: conversationId,
      type: 'message',
      payload: { text: 'Hello' } as MessagePayload,
      finality: 'turn',
      agentId: 'test-agent'
    });
    
    expect(result.conversation).toBe(conversationId);
    expect(result.turn).toBe(1);
    expect(result.event).toBe(1);
    
    // Verify we can read it back
    const snapshot = app.orchestrator.getConversationSnapshot(conversationId);
    const messages = snapshot.events.filter(e => e.type === 'message');
    expect(messages.length).toBe(1);
    expect((messages[0]!.payload as MessagePayload).text).toBe('Hello');
    
    // List conversations
    const conversations = app.orchestrator.listConversations({});
    expect(conversations.length).toBe(1);
    expect(conversations[0]!.title).toBe('Test conversation');
    
    await app.shutdown();
  });
  
  it('shares storage across routes', async () => {
    const app = new App({ dbPath: ':memory:' });
    
    // Create conversation through orchestrator
    const id1 = app.orchestrator.createConversation({ title: 'Conv 1' });
    const id2 = app.orchestrator.createConversation({ title: 'Conv 2' });
    
    // Both should be visible
    const list = app.orchestrator.listConversations({});
    expect(list.length).toBe(2);
    
    // Add events to different conversations
    app.orchestrator.appendEvent({
      conversation: id1,
      type: 'message',
      payload: { text: 'Message 1' } as MessagePayload,
      finality: 'none',
      agentId: 'agent1'
    });
    
    app.orchestrator.appendEvent({
      conversation: id2,
      type: 'message',
      payload: { text: 'Message 2' } as MessagePayload,
      finality: 'none',
      agentId: 'agent2'
    });
    
    // Each conversation should have its own events
    const snap1 = app.orchestrator.getConversationSnapshot(id1);
    const snap2 = app.orchestrator.getConversationSnapshot(id2);
    
    const msgs1 = snap1.events.filter(e => e.type === 'message');
    const msgs2 = snap2.events.filter(e => e.type === 'message');
    expect(msgs1.length).toBe(1);
    expect(msgs2.length).toBe(1);
    expect((msgs1[0]!.payload as MessagePayload).text).toBe('Message 1');
    expect((msgs2[0]!.payload as MessagePayload).text).toBe('Message 2');
    
    await app.shutdown();
  });
});