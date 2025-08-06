import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ConversationOrchestrator } from '../../src/backend/core/orchestrator.js';
import { ConversationDatabase } from '../../src/backend/db/database.js';
import type { 
  CreateConversationRequest, 
  SequentialScriptConfig,
  LLMProvider 
} from '../../src/types/index.js';

describe('Resurrection Lookback Period Tests', () => {
  let dbPath: string;
  let mockLLMProvider: LLMProvider;

  beforeEach(() => {
    // Use a unique file-based database for each test
    dbPath = `/tmp/test-resurrection-lookback-${Date.now()}.db`;
    
    // Mock LLM provider
    mockLLMProvider = {
      generateResponse: async () => ({ content: 'mock response' })
    } as any;
    
    // Clear any env vars to ensure test isolation
    delete process.env.RESURRECTION_LOOKBACK_HOURS;
  });

  afterEach(() => {
    // Clean up env vars
    delete process.env.RESURRECTION_LOOKBACK_HOURS;
  });

  test('should use default 24 hour lookback when no config provided', async () => {
    const orchestrator1 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Create a conversation
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'test-lookback',
        conversationTitle: 'Test Default Lookback'
      },
      agents: [{
        id: 'agent-1',
        strategyType: 'sequential_script',
        shouldInitiateConversation: true,
        script: [{
          trigger: { type: 'conversation_ready' },
          steps: [{ type: 'response', content: 'Hello' }]
        }]
      } as SequentialScriptConfig]
    };

    const { conversation } = await orchestrator1.createConversation(config);
    await orchestrator1.startConversation(conversation.id);
    
    // Wait for turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Manually update the conversation's last turn timestamp to be 25 hours ago
    const db = orchestrator1.getDbInstance();
    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.db.prepare(`UPDATE conversation_turns SET timestamp = ? WHERE conversation_id = ?`).run(oldTimestamp, conversation.id);
    
    orchestrator1.close();
    
    // Create new orchestrator with default config
    const orchestrator2 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Give resurrection time
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check that the conversation was marked inactive (no activity in 24 hours)
    const conv = orchestrator2.getConversation(conversation.id);
    expect(conv?.status).toBe('inactive');
    
    orchestrator2.close();
  }, 3000);

  test('should respect RESURRECTION_LOOKBACK_HOURS environment variable', async () => {
    // Set env var to 48 hours
    process.env.RESURRECTION_LOOKBACK_HOURS = '48';
    
    const orchestrator1 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Create a conversation
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'test-env-lookback',
        conversationTitle: 'Test Env Lookback'
      },
      agents: [{
        id: 'agent-1',
        strategyType: 'sequential_script',
        shouldInitiateConversation: true,
        script: [{
          trigger: { type: 'conversation_ready' },
          steps: [{ type: 'response', content: 'Hello' }]
        }]
      } as SequentialScriptConfig]
    };

    const { conversation } = await orchestrator1.createConversation(config);
    await orchestrator1.startConversation(conversation.id);
    
    // Wait for turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Update timestamp to be 30 hours ago (within 48 hour window)
    const db = orchestrator1.getDbInstance();
    const oldTimestamp = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    db.db.prepare(`UPDATE conversation_turns SET timestamp = ? WHERE conversation_id = ?`).run(oldTimestamp, conversation.id);
    
    orchestrator1.close();
    
    // Create new orchestrator (will use env var)
    const orchestrator2 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Give resurrection time
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Check that the conversation was resurrected (activity within 48 hours)
    const conv = orchestrator2.getConversation(conversation.id);
    expect(conv?.status).toBe('active');
    
    orchestrator2.close();
  }, 3000);

  test('should override config with environment variable', async () => {
    // Set env var to 12 hours
    process.env.RESURRECTION_LOOKBACK_HOURS = '12';
    
    // Create orchestrator with config specifying 48 hours (should be overridden by env)
    const orchestrator1 = new ConversationOrchestrator(dbPath, mockLLMProvider, undefined, {
      resurrectionLookbackHours: 48
    });
    
    // Create a conversation
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'test-override',
        conversationTitle: 'Test Override'
      },
      agents: [{
        id: 'agent-1',
        strategyType: 'sequential_script',
        shouldInitiateConversation: true,
        script: [{
          trigger: { type: 'conversation_ready' },
          steps: [{ type: 'response', content: 'Hello' }]
        }]
      } as SequentialScriptConfig]
    };

    const { conversation } = await orchestrator1.createConversation(config);
    await orchestrator1.startConversation(conversation.id);
    
    // Wait for turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Update timestamp to be 15 hours ago (outside 12 hour env window, inside 48 hour config window)
    const db = orchestrator1.getDbInstance();
    const oldTimestamp = new Date(Date.now() - 15 * 60 * 60 * 1000).toISOString();
    db.db.prepare(`UPDATE conversation_turns SET timestamp = ? WHERE conversation_id = ?`).run(oldTimestamp, conversation.id);
    
    orchestrator1.close();
    
    // Create new orchestrator with same config (env var should override)
    const orchestrator2 = new ConversationOrchestrator(dbPath, mockLLMProvider, undefined, {
      resurrectionLookbackHours: 48
    });
    
    // Give resurrection time
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check that conversation was marked inactive (env var 12 hours overrides config 48 hours)
    const conv = orchestrator2.getConversation(conversation.id);
    expect(conv?.status).toBe('inactive');
    
    orchestrator2.close();
  }, 3000);

  test('should mark stale conversations inactive while keeping recent ones active', async () => {
    const orchestrator1 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Create 5 conversations with different ages
    const conversations = [];
    const ages = [
      { hours: 30, expectedStatus: 'inactive', description: '30 hours ago - STALE' },
      { hours: 10, expectedStatus: 'active', description: '10 hours ago - RECENT' },
      { hours: 25, expectedStatus: 'inactive', description: '25 hours ago - STALE' },
      { hours: 1, expectedStatus: 'active', description: '1 hour ago - VERY RECENT' },
      { hours: 23.5, expectedStatus: 'active', description: '23.5 hours ago - JUST WITHIN WINDOW' }
    ];
    
    for (let i = 0; i < ages.length; i++) {
      const config: CreateConversationRequest = {
        metadata: {
          scenarioId: `test-multi-${i}`,
          conversationTitle: `Conversation ${i} - ${ages[i].description}`
        },
        agents: [{
          id: `agent-${i}`,
          strategyType: 'sequential_script',
          shouldInitiateConversation: true,
          script: [{
            trigger: { type: 'conversation_ready' },
            steps: [{ type: 'response', content: `Message ${i}` }]
          }]
        } as SequentialScriptConfig]
      };
      
      const { conversation } = await orchestrator1.createConversation(config);
      await orchestrator1.startConversation(conversation.id);
      conversations.push({
        id: conversation.id,
        ...ages[i]
      });
    }
    
    // Wait for all turns to complete
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Verify all conversations are initially active
    for (const conv of conversations) {
      const c = orchestrator1.getConversation(conv.id);
      expect(c?.status).toBe('active');
    }
    
    const db = orchestrator1.getDbInstance();
    
    // Update timestamps to simulate different ages
    for (const conv of conversations) {
      const timestamp = new Date(Date.now() - conv.hours * 60 * 60 * 1000).toISOString();
      db.db.prepare(`UPDATE conversation_turns SET timestamp = ? WHERE conversation_id = ?`)
        .run(timestamp, conv.id);
    }
    
    orchestrator1.close();
    
    // Create new orchestrator with default 24 hour lookback
    const orchestrator2 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Give resurrection time
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Check conversation statuses match expectations
    for (const conv of conversations) {
      const c = orchestrator2.getConversation(conv.id);
      expect(c?.status).toBe(conv.expectedStatus);
      console.log(`[Test] Conversation ${conv.description}: ${c?.status} (expected: ${conv.expectedStatus})`);
    }
    
    // Also verify counts
    const activeCount = conversations.filter(c => c.expectedStatus === 'active').length;
    const inactiveCount = conversations.filter(c => c.expectedStatus === 'inactive').length;
    
    // Count actual active and inactive conversations
    let actualActive = 0;
    let actualInactive = 0;
    for (const conv of conversations) {
      const c = orchestrator2.getConversation(conv.id);
      if (c?.status === 'active') actualActive++;
      if (c?.status === 'inactive') actualInactive++;
    }
    
    expect(actualActive).toBe(activeCount);
    expect(actualInactive).toBe(inactiveCount);
    
    console.log(`[Test] Summary: ${actualActive} active, ${actualInactive} inactive conversations`);
    
    orchestrator2.close();
  }, 3000);

  test('should mark stale conversations as inactive on orchestrator startup', async () => {
    const orchestrator1 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Create an active conversation
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'test-stale-marking',
        conversationTitle: 'Test Stale Marking'
      },
      agents: [{
        id: 'agent-1',
        strategyType: 'sequential_script',
        shouldInitiateConversation: true,
        script: [{
          trigger: { type: 'conversation_ready' },
          steps: [{ type: 'response', content: 'Hello' }]
        }]
      } as SequentialScriptConfig]
    };

    const { conversation } = await orchestrator1.createConversation(config);
    await orchestrator1.startConversation(conversation.id);
    
    // Wait for turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify conversation is active
    let conv = orchestrator1.getConversation(conversation.id);
    expect(conv?.status).toBe('active');
    
    // Update timestamp to be 30 hours ago (beyond default 24 hour window)
    const db = orchestrator1.getDbInstance();
    const oldTimestamp = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    db.db.prepare(`UPDATE conversation_turns SET timestamp = ? WHERE conversation_id = ?`).run(oldTimestamp, conversation.id);
    
    // Close without marking inactive (simulating crash/restart)
    orchestrator1.close();
    
    // Verify in database that conversation is still marked active before resurrection
    const db2 = new ConversationDatabase(dbPath);
    const rawConv = db2.db.prepare(`SELECT status FROM conversations WHERE id = ?`).get(conversation.id) as any;
    expect(rawConv.status).toBe('active');
    db2.close();
    
    // Create new orchestrator - this triggers resurrection which should mark stale convos as inactive
    const orchestrator2 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Give resurrection time to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check that the conversation was automatically marked as inactive
    conv = orchestrator2.getConversation(conversation.id);
    expect(conv?.status).toBe('inactive');
    
    // Verify in database that status was updated
    const db3 = new ConversationDatabase(dbPath);
    const updatedConv = db3.db.prepare(`SELECT status FROM conversations WHERE id = ?`).get(conversation.id) as any;
    expect(updatedConv.status).toBe('inactive');
    db3.close();
    
    orchestrator2.close();
  }, 3000);

  test('should handle invalid environment variable gracefully', async () => {
    // Set invalid env var
    process.env.RESURRECTION_LOOKBACK_HOURS = 'invalid';
    
    const orchestrator1 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Should use default 24 hours when env var is invalid
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'test-invalid',
        conversationTitle: 'Test Invalid Env'
      },
      agents: [{
        id: 'agent-1',
        strategyType: 'sequential_script',
        shouldInitiateConversation: true,
        script: [{
          trigger: { type: 'conversation_ready' },
          steps: [{ type: 'response', content: 'Hello' }]
        }]
      } as SequentialScriptConfig]
    };

    const { conversation } = await orchestrator1.createConversation(config);
    await orchestrator1.startConversation(conversation.id);
    
    // Wait for turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Update timestamp to be 25 hours ago
    const db = orchestrator1.getDbInstance();
    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.db.prepare(`UPDATE conversation_turns SET timestamp = ? WHERE conversation_id = ?`).run(oldTimestamp, conversation.id);
    
    orchestrator1.close();
    
    // Create new orchestrator (should use default due to invalid env var)
    const orchestrator2 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Give resurrection time
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check that conversation was marked inactive (default 24 hour lookback)
    const conv = orchestrator2.getConversation(conversation.id);
    expect(conv?.status).toBe('inactive');
    
    orchestrator2.close();
  }, 3000);
});