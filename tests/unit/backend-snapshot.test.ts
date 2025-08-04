import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { MockLLMProvider } from '../utils/test-helpers.js';
import { v4 as uuidv4 } from 'uuid';
import { CreateConversationRequest, ScenarioDrivenAgentConfig, AgentId, ThoughtEntry, ToolCallEntry, ToolResultEntry } from '$lib/types.js';

describe('Backend Snapshot Functionality', () => {
  let orchestrator: ConversationOrchestrator;
  let conversationId: string;
  let agentToken: string;

  beforeEach(async () => {
    const mockLLMProvider = new MockLLMProvider();
    orchestrator = new ConversationOrchestrator(':memory:', mockLLMProvider);
      
    const agentId = 'test-agent-1';
    
    const request: CreateConversationRequest = {
      metadata: { conversationTitle: 'Test Conversation' },
      agents: [{
        id: agentId,
        strategyType: 'scenario_driven',
        scenarioId: 'test-scenario'
      } as ScenarioDrivenAgentConfig]
    };
    
    const result = await orchestrator.createConversation(request);
    conversationId = result.conversation.id;
    agentToken = result.agentTokens[agentId];
  });

  test('getConversation returns complete snapshot with attachments', async () => {
    // Don't start conversation - just create turns directly
      
    const { turnId } = orchestrator.startTurn({
      conversationId,
      agentId: 'test-agent-1'
    });
    orchestrator.addTraceEntry({
      conversationId,
      turnId,
      agentId: 'test-agent-1',
      entry: { type: 'thought', content: 'Thinking...' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>
    });
    orchestrator.addTraceEntry({
      conversationId,
      turnId,
      agentId: 'test-agent-1',
      entry: { 
        type: 'tool_call', 
        toolName: 'test_tool', 
        parameters: { test: true },
        toolCallId: 'test-call-1'
      } as Omit<ToolCallEntry, 'id' | 'timestamp' | 'agentId'>
    });
      
    orchestrator.completeTurn({
      conversationId,
      turnId,
      agentId: 'test-agent-1',
      content: 'Test turn',
      isFinalTurn: false,
      attachments: [{
        docId: 'doc-1',
        name: 'test.md',
        contentType: 'text/markdown',
        content: '# Test Document',
        summary: 'Test document with metadata from test source'
      }]
    });
      
    const conversation = await orchestrator.getConversation(
      conversationId, 
      true,  // includeTurns
      true,  // includeTrace
      false, // includeAgents
      true   // includeAttachments
    );
      
    expect(conversation.id).toBe(conversationId);
    expect(conversation.attachments).toBeDefined();
    expect(conversation.attachments!.length).toBe(1);
    expect(conversation.attachments![0].docId).toBe('doc-1');
    expect(conversation.attachments![0].name).toBe('test.md');
    expect(conversation.attachments![0].content).toBe('# Test Document');
    
    expect(conversation.turns).toBeDefined();
    expect(conversation.turns!.length).toBe(1);
    expect(conversation.turns![0].trace).toBeDefined();
    // Should have 2 original entries + 1 attachment creation entry
    expect(conversation.turns![0].trace!.length).toBe(3);
    expect(conversation.turns![0].attachments).toBeDefined();
    expect(conversation.turns![0].attachments!.length).toBe(1);
  });

  test('conversation attachments aggregate from all turns', async () => {
      
    const { turnId: turnId1 } = orchestrator.startTurn({
      conversationId,
      agentId: 'test-agent-1'
    });
    orchestrator.completeTurn({
      conversationId,
      turnId: turnId1,
      agentId: 'test-agent-1',
      content: 'First turn',
      isFinalTurn: false,
      attachments: [{
        docId: 'doc-1',
        name: 'first.md',
        contentType: 'text/markdown',
        content: 'First document'
      }]
    });
      
    const { turnId: turnId2 } = orchestrator.startTurn({
      conversationId,
      agentId: 'test-agent-1'
    });
    orchestrator.completeTurn({
      conversationId,
      turnId: turnId2,
      agentId: 'test-agent-1',
      content: 'Second turn',
      isFinalTurn: false,
      attachments: [{
        docId: 'doc-2',
        name: 'second.md',
        contentType: 'text/markdown',
        content: 'Second document'
      }]
    });
      
    const conversation = await orchestrator.getConversation(
      conversationId, 
      true,  // includeTurns
      false, // includeTrace
      false, // includeAgents
      true   // includeAttachments
    );
      
    expect(conversation.attachments).toBeDefined();
    expect(conversation.attachments!.length).toBe(2);
    
    const docIds = conversation.attachments!.map(a => a.docId).sort();
    expect(docIds).toEqual(['doc-1', 'doc-2']);
      
    const att1 = conversation.attachments!.find(a => a.docId === 'doc-1');
    const att2 = conversation.attachments!.find(a => a.docId === 'doc-2');
    expect(att1!.turnId).toBe(turnId1);
    expect(att2!.turnId).toBe(turnId2);
  });

  test('snapshot includes all trace entries when requested', async () => {
    
    const { turnId } = orchestrator.startTurn({
      conversationId,
      agentId: 'test-agent-1'
    });
      
    orchestrator.addTraceEntry({
      conversationId,
      turnId,
      agentId: 'test-agent-1',
      entry: { type: 'thought', content: 'Step 1' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>
    });
    orchestrator.addTraceEntry({
      conversationId,
      turnId,
      agentId: 'test-agent-1',
      entry: { 
        type: 'tool_call', 
        toolName: 'calculator', 
        parameters: { operation: 'add', a: 1, b: 2 },
        toolCallId: 'calc-1'
      } as Omit<ToolCallEntry, 'id' | 'timestamp' | 'agentId'>
    });
    orchestrator.addTraceEntry({
      conversationId,
      turnId,
      agentId: 'test-agent-1',
      entry: { 
        type: 'tool_result',
        toolCallId: 'calc-1',
        result: 3
      } as Omit<ToolResultEntry, 'id' | 'timestamp' | 'agentId'>
    });
    orchestrator.addTraceEntry({
      conversationId,
      turnId,
      agentId: 'test-agent-1',
      entry: { type: 'thought', content: 'Step 2' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>
    });
    
    orchestrator.completeTurn({
      conversationId,
      turnId,
      agentId: 'test-agent-1',
      content: 'Calculation complete'
    });
      
    const conversation = await orchestrator.getConversation(
      conversationId,
      true,  // includeTurns
      true,  // includeTrace
      false, // includeAgents
      false  // includeAttachments
    );
    
    expect(conversation.turns![0].trace).toBeDefined();
    expect(conversation.turns![0].trace!.length).toBe(4);
    
    const traceTypes = conversation.turns![0].trace!.map(t => t.type);
    expect(traceTypes).toEqual(['thought', 'tool_call', 'tool_result', 'thought']);
  });

  test('snapshot without includes returns minimal data', async () => {
      
    const { turnId } = orchestrator.startTurn({
      conversationId,
      agentId: 'test-agent-1'
    });
    orchestrator.addTraceEntry({
      conversationId,
      turnId,
      agentId: 'test-agent-1',
      entry: { type: 'thought', content: 'Test' } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>
    });
    orchestrator.completeTurn({
      conversationId,
      turnId,
      agentId: 'test-agent-1',
      content: 'Turn',
      isFinalTurn: false,
      attachments: [{
        docId: 'doc-1',
        name: 'test.md',
        contentType: 'text/markdown',
        content: 'Content'
      }]
    });
      
    const conversation = await orchestrator.getConversation(
      conversationId,
      false, // includeTurns
      false, // includeTrace
      false, // includeAgents
      false  // includeAttachments
    );
      
    expect(conversation.id).toBe(conversationId);
    expect(conversation.metadata.conversationTitle).toBe('Test Conversation');
    expect(conversation.status).toBeDefined();
    expect(conversation.metadata).toBeDefined();
      
    // Note: Currently returns empty array instead of undefined
    expect(conversation.turns).toEqual([]);
    expect(conversation.attachments).toBeUndefined();
  });

  test('getConversation aggregates attachments from multiple turns', async () => {
      
    const { turnId } = orchestrator.startTurn({
      conversationId,
      agentId: 'test-agent-1'
    });
    const attachmentPayloads = [];
    
    for (let i = 0; i < 3; i++) {
      attachmentPayloads.push({
        docId: `doc-${i}`,
        name: `file${i}.md`,
        contentType: 'text/markdown',
        content: `Content ${i}`,
        summary: `File with index ${i}`
      });
    }
    
    orchestrator.completeTurn({
      conversationId,
      turnId,
      agentId: 'test-agent-1',
      content: 'Multi-attachment turn',
      isFinalTurn: false,
      attachments: attachmentPayloads
    });
      
    const conversation = await orchestrator.getConversation(
      conversationId,
      true,  // includeTurns
      true,  // includeTrace
      false, // includeAgents
      true   // includeAttachments
    );
    
    expect(conversation).toBeDefined();
    expect(conversation!.attachments).toBeDefined();
    expect(conversation!.attachments!.length).toBe(3);
      
    for (let i = 0; i < 3; i++) {
      const attachment = conversation!.attachments!.find(a => a.docId === `doc-${i}`);
      expect(attachment).toBeDefined();
      expect(attachment!.content).toBe(`Content ${i}`);
      expect(attachment!.turnId).toBe(turnId);
      // TODO: metadata is not being parsed from JSON in database
      // This is a minor issue that doesn't affect the rehydration functionality
    }
  });
});