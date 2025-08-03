import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationDatabase } from '$backend/db/database.js';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { InProcessOrchestratorClient } from '$client/impl/in-process.client.js';
import { Attachment } from '$lib/types.js';
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

  test('should create and retrieve attachments', async () => {
    // Create a conversation and turn
    const { conversation, agentTokens } = await orchestrator.createConversation({
      name: 'Test Conversation',
      agents: [{
        agentId: { id: 'agent1', label: 'Agent 1', role: 'assistant' },
        strategyType: 'test'
      }]
    });

    const agentToken = agentTokens['agent1'];
    const auth = orchestrator.validateAgentToken(agentToken);
    
    // Start a turn
    const { turnId } = orchestrator.startTurn({
      conversationId: conversation.id,
      agentId: 'agent1'
    });

    // Register an attachment
    const attachmentId = orchestrator.registerAttachment({
      conversationId: conversation.id,
      turnId,
      name: 'Test Document.md',
      contentType: 'text/markdown',
      content: '# Test Document\n\nThis is a test attachment.',
      createdByAgentId: 'agent1'
    });

    expect(attachmentId).toMatch(/^att_/);

    // Retrieve the attachment
    const attachment = db.getAttachment(attachmentId);
    expect(attachment).toBeTruthy();
    expect(attachment?.name).toBe('Test Document.md');
    expect(attachment?.contentType).toBe('text/markdown');
    expect(attachment?.content).toBe('# Test Document\n\nThis is a test attachment.');
    expect(attachment?.conversationId).toBe(conversation.id);
    expect(attachment?.turnId).toBe(turnId);
  });

  test('should validate attachments on turn completion', async () => {
    // Create a conversation
    const { conversation, agentTokens } = await orchestrator.createConversation({
      name: 'Test Conversation',
      agents: [{
        agentId: { id: 'agent1', label: 'Agent 1', role: 'assistant' },
        strategyType: 'test'
      }]
    });

    // Start a turn
    const { turnId } = orchestrator.startTurn({
      conversationId: conversation.id,
      agentId: 'agent1'
    });

    // Try to complete turn with invalid attachment ID
    expect(() => {
      orchestrator.completeTurn({
        conversationId: conversation.id,
        turnId,
        agentId: 'agent1',
        content: 'Test message',
        attachments: ['invalid_attachment_id']
      });
    }).toThrow('Attachment invalid_attachment_id not found');

    // Register a valid attachment
    const attachmentId = orchestrator.registerAttachment({
      conversationId: conversation.id,
      turnId,
      name: 'Valid Document.md',
      contentType: 'text/markdown',
      content: 'Valid content',
      createdByAgentId: 'agent1'
    });

    // Complete turn with valid attachment
    const turn = orchestrator.completeTurn({
      conversationId: conversation.id,
      turnId,
      agentId: 'agent1',
      content: 'Message with attachment',
      attachments: [attachmentId]
    });

    expect(turn.attachments).toEqual([attachmentId]);
  });

  test('should list attachments by conversation and turn', async () => {
    // Create a conversation
    const { conversation } = await orchestrator.createConversation({
      name: 'Test Conversation',
      agents: [{
        agentId: { id: 'agent1', label: 'Agent 1', role: 'assistant' },
        strategyType: 'test'
      }]
    });

    // Create multiple turns with attachments
    const turn1 = orchestrator.startTurn({
      conversationId: conversation.id,
      agentId: 'agent1'
    });

    const att1 = orchestrator.registerAttachment({
      conversationId: conversation.id,
      turnId: turn1.turnId,
      name: 'Doc1.md',
      contentType: 'text/markdown',
      content: 'Content 1',
      createdByAgentId: 'agent1'
    });

    const att2 = orchestrator.registerAttachment({
      conversationId: conversation.id,
      turnId: turn1.turnId,
      name: 'Doc2.md',
      contentType: 'text/markdown',
      content: 'Content 2',
      createdByAgentId: 'agent1'
    });

    orchestrator.completeTurn({
      conversationId: conversation.id,
      turnId: turn1.turnId,
      agentId: 'agent1',
      content: 'First message',
      attachments: [att1, att2]
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

  test('should handle attachment registration via client', async () => {
    // Create conversation and client
    const { conversation, agentTokens } = await orchestrator.createConversation({
      name: 'Test Conversation',
      agents: [{
        agentId: { id: 'agent1', label: 'Agent 1', role: 'assistant' },
        strategyType: 'test'
      }]
    });

    const client = new InProcessOrchestratorClient(orchestrator);
    await client.connect(agentTokens['agent1']);
    await client.authenticate(agentTokens['agent1']);

    // Start turn via client
    const turnId = await client.startTurn();

    // Register attachment via client
    const attachmentId = await client.registerAttachment({
      conversationId: conversation.id,
      turnId,
      name: 'Client Doc.md',
      contentType: 'text/markdown',
      content: '# Client Document',
      createdByAgentId: 'agent1'
    });

    expect(attachmentId).toMatch(/^att_/);

    // Complete turn with attachment
    const turn = await client.completeTurn(
      turnId,
      'Message from client',
      false,
      undefined,
      [attachmentId]
    );

    expect(turn.attachments).toEqual([attachmentId]);
  });
});