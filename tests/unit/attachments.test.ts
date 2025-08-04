import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationDatabase } from '$backend/db/database.js';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { InProcessOrchestratorClient } from '$client/impl/in-process.client.js';
import { Attachment, AttachmentPayload, StaticReplayConfig } from '$lib/types.js';
import { createLLMProvider } from '$llm/factory.js';

describe('Attachment System', () => {
  let orchestrator: ConversationOrchestrator;
  let db: ConversationDatabase;
  
  beforeEach(() => {
    // Create a mock LLM provider
    const mockLLM = createLLMProvider({
      provider: 'google',
      apiKey: 'test-key',
      model: 'test-model'
    });
    
    orchestrator = new ConversationOrchestrator(':memory:', mockLLM);
    db = orchestrator.getDbInstance();
  });

  test('should create and retrieve attachments atomically', async () => {
    // Create a conversation
    const { conversation } = await orchestrator.createConversation({
      metadata: { conversationTitle: "Test Conversation" },
      agents: [{
        id: "agent1",
        strategyType: 'static_replay',
        script: []
      } as StaticReplayConfig]
    });

    // Start a turn
    const { turnId } = orchestrator.startTurn({
      conversationId: conversation.id,
      agentId: 'agent1'
    });

    // Create attachment payload
    const attachmentPayload: AttachmentPayload = {
      docId: 'doc_test_123',
      name: 'Test Document.md',
      contentType: 'text/markdown',
      content: '# Test Document\n\nThis is a test attachment.',
      summary: 'A test attachment'
    };

    // Complete turn with embedded attachment
    const turn = orchestrator.completeTurn({
      conversationId: conversation.id,
      turnId,
      agentId: 'agent1',
      content: 'Message with attachment',
      attachments: [attachmentPayload]
    });

    expect(turn.attachments).toBeDefined();
    expect(turn.attachments).toHaveLength(1);
    const attachmentId = turn.attachments![0];
    expect(attachmentId).toMatch(/^att_/);

    // Retrieve the attachment
    const attachment = db.getAttachment(attachmentId);
    expect(attachment).toBeTruthy();
    expect(attachment?.name).toBe('Test Document.md');
    expect(attachment?.contentType).toBe('text/markdown');
    expect(attachment?.content).toBe('# Test Document\n\nThis is a test attachment.');
    expect(attachment?.summary).toBe('A test attachment');
    expect(attachment?.docId).toBe('doc_test_123');
    expect(attachment?.conversationId).toBe(conversation.id);
    expect(attachment?.turnId).toBe(turnId);
  });

  test('should handle multiple attachments in atomic turn completion', async () => {
    // Create a conversation
    const { conversation } = await orchestrator.createConversation({
      metadata: { conversationTitle: "Test Conversation" },
      agents: [{
        id: "agent1",
        strategyType: 'static_replay',
        script: []
      } as StaticReplayConfig]
    });

    // Start a turn
    const { turnId } = orchestrator.startTurn({
      conversationId: conversation.id,
      agentId: 'agent1'
    });

    // Create multiple attachment payloads
    const attachmentPayloads: AttachmentPayload[] = [
      {
        docId: 'doc_1',
        name: 'Document 1.md',
        contentType: 'text/markdown',
        content: '# Document 1',
        summary: 'First document'
      },
      {
        docId: 'doc_2',
        name: 'Document 2.md',
        contentType: 'text/markdown',
        content: '# Document 2',
        summary: 'Second document'
      }
    ];

    // Complete turn with multiple attachments
    const turn = orchestrator.completeTurn({
      conversationId: conversation.id,
      turnId,
      agentId: 'agent1',
      content: 'Message with multiple attachments',
      attachments: attachmentPayloads
    });

    expect(turn.attachments).toBeDefined();
    expect(turn.attachments).toHaveLength(2);
    
    // Verify all attachments were created
    for (let i = 0; i < turn.attachments!.length; i++) {
      const attachmentId = turn.attachments![i];
      const attachment = db.getAttachment(attachmentId);
      expect(attachment).toBeTruthy();
      expect(attachment?.docId).toBe(attachmentPayloads[i].docId);
      expect(attachment?.name).toBe(attachmentPayloads[i].name);
      expect(attachment?.content).toBe(attachmentPayloads[i].content);
    }
  });

  test('should list attachments by conversation and turn', async () => {
    // Create a conversation
    const { conversation } = await orchestrator.createConversation({
      metadata: { conversationTitle: "Test Conversation" },
      agents: [{
        id: "agent1",
        strategyType: 'static_replay',
        script: []
      } as StaticReplayConfig]
    });

    // Create turn with attachments
    const turn1 = orchestrator.startTurn({
      conversationId: conversation.id,
      agentId: 'agent1'
    });

    const attachmentPayloads: AttachmentPayload[] = [
      {
        docId: 'doc1',
        name: 'Doc1.md',
        contentType: 'text/markdown',
        content: 'Content 1'
      },
      {
        docId: 'doc2',
        name: 'Doc2.md',
        contentType: 'text/markdown',
        content: 'Content 2'
      }
    ];

    orchestrator.completeTurn({
      conversationId: conversation.id,
      turnId: turn1.turnId,
      agentId: 'agent1',
      content: 'First message',
      attachments: attachmentPayloads
    });

    // List attachments by conversation
    const conversationAttachments = db.listAttachments(conversation.id);
    expect(conversationAttachments).toHaveLength(2);
    expect(conversationAttachments.map(a => a.name)).toContain('Doc1.md');
    expect(conversationAttachments.map(a => a.name)).toContain('Doc2.md');

    // List attachments by turn
    const turnAttachments = db.listAttachmentsByTurn(turn1.turnId);
    expect(turnAttachments).toHaveLength(2);
  });

  test('should handle atomic attachment creation via client', async () => {
    // Create conversation and client
    const { conversation, agentTokens } = await orchestrator.createConversation({
      metadata: { conversationTitle: "Test Conversation" },
      agents: [{
        id: "agent1",
        strategyType: 'static_replay',
        script: []
      } as StaticReplayConfig]
    });

    const client = new InProcessOrchestratorClient(orchestrator);
    await client.connect(agentTokens['agent1']);
    await client.authenticate(agentTokens['agent1']);

    // Start turn via client
    const turnId = await client.startTurn();

    // Create attachment payload
    const attachmentPayload: AttachmentPayload = {
      docId: 'client_doc_1',
      name: 'Client Doc.md',
      contentType: 'text/markdown',
      content: '# Client Document',
      summary: 'Document created via client'
    };

    // Complete turn with embedded attachment
    const turn = await client.completeTurn(
      turnId,
      'Message from client',
      false,
      undefined,
      [attachmentPayload]
    );

    expect(turn.attachments).toBeDefined();
    expect(turn.attachments).toHaveLength(1);
    
    // Verify attachment was created with correct data
    const attachmentId = turn.attachments![0];
    const attachment = await client.getAttachment(attachmentId);
    expect(attachment).toBeTruthy();
    expect(attachment?.docId).toBe('client_doc_1');
    expect(attachment?.name).toBe('Client Doc.md');
    expect(attachment?.content).toBe('# Client Document');
    expect(attachment?.summary).toBe('Document created via client');
  });
});