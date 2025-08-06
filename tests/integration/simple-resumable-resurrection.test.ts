import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationOrchestrator } from '../../src/backend/core/orchestrator.js';
import type { CreateConversationRequest, LLMProvider } from '../../src/types/index.js';

describe('SimpleResumableAgent Resurrection Tests', () => {
  let dbPath: string;
  let mockLLMProvider: LLMProvider;

  beforeEach(() => {
    // Use a unique file-based database for each test to test real persistence
    dbPath = `/tmp/test-simple-resumable-${Date.now()}.db`;
    
    // Mock LLM provider
    mockLLMProvider = {
      generateResponse: async () => ({ content: 'mock response' })
    } as any;
  });

  test('should resurrect and complete with SimpleResumableAgent', async () => {
    // Step 1: Create first orchestrator instance and start a conversation
    const orchestrator1 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'simple-resurrection-test',
        conversationTitle: 'Test Simple Resurrection'
      },
      agents: [
        {
          id: 'agent1',
          strategyType: 'simple_resumable',
          shouldInitiateConversation: true
        },
        {
          id: 'agent2',
          strategyType: 'simple_resumable'
        }
      ]
    };

    const { conversation } = await orchestrator1.createConversation(config);
    const conversationId = conversation.id;
    
    console.log('[Test] Starting conversation:', conversationId);
    
    // Start the conversation
    await orchestrator1.startConversation(conversationId);
    
    // Wait for exactly 2 turns (one from each agent) to ensure we interrupt mid-conversation
    // We need to be VERY quick to catch them before all messages complete
    await new Promise(resolve => setTimeout(resolve, 50)); // Just 50ms to let first turns start
    
    // Check progress before crash - ensure we have at least one turn from each agent
    const before = orchestrator1.getConversation(conversationId, true);
    console.log(`[Test] Before crash: ${before.turns.length} turns`);
    console.log('[Test] Turns before crash:');
    before.turns.forEach((turn, i) => {
      console.log(`  ${i}: ${turn.agentId} - "${turn.content}"`);
    });
    
    // Ensure we have at least one turn from each agent before crash
    expect(before.turns.length).toBeGreaterThanOrEqual(2);
    const agent1TurnsBefore = before.turns.filter(t => t.agentId === 'agent1');
    const agent2TurnsBefore = before.turns.filter(t => t.agentId === 'agent2');
    expect(agent1TurnsBefore.length).toBeGreaterThanOrEqual(1);
    expect(agent2TurnsBefore.length).toBeGreaterThanOrEqual(1);
    
    // Verify first turns happened
    expect(before.turns[0].agentId).toBe('agent1');
    expect(before.turns[0].content).toBe('Message 1 of 5');
    expect(before.turns[1].agentId).toBe('agent2');
    expect(before.turns[1].content).toBe('Message 1 of 5');
    
    // Step 2: Simulate crash - close the orchestrator
    console.log('[Test] Simulating orchestrator crash...');
    
    // Get the database instance to check active conversations before closing
    const db1 = orchestrator1.getDbInstance();
    const activeConvsBefore = db1.getActiveConversations();
    console.log(`[Test] Active conversations before crash: ${activeConvsBefore.length}`);
    console.log(`[Test] Active conversation IDs: ${activeConvsBefore.map(c => c.id).join(', ')}`);
    
    orchestrator1.close();
    
    // Step 3: Create new orchestrator instance with same database
    console.log('[Test] Creating new orchestrator instance...');
    const orchestrator2 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Check what conversations the new orchestrator sees
    const db2 = orchestrator2.getDbInstance();
    const activeConvsAfter = db2.getActiveConversations();
    console.log(`[Test] Active conversations after resurrection: ${activeConvsAfter.length}`);
    console.log(`[Test] Active conversation IDs after: ${activeConvsAfter.map(c => c.id).join(', ')}`);
    
    // Give resurrection time to complete
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Step 4: Verify conversation was resurrected
    const afterResurrection = orchestrator2.getConversation(conversationId, true);
    if (!afterResurrection) {
      console.error(`[Test] Conversation ${conversationId} not found after resurrection!`);
      // Try to query the database directly
      const dbConv = db2.getConversation(conversationId);
      console.log(`[Test] Database query result:`, dbConv ? `Found with status ${dbConv.status}` : 'Not found');
    }
    console.log(`[Test] After resurrection: ${afterResurrection?.turns?.length || 0} turns`);
    expect(afterResurrection).toBeDefined();
    expect(afterResurrection.status).toBe('active');
    expect(afterResurrection.turns.length).toBeGreaterThanOrEqual(before.turns.length);
    
    // Step 5: Wait for agents to continue after resurrection
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Step 6: Verify both agents produced new turns after resurrection
    const finalConv = orchestrator2.getConversation(conversationId, true);
    console.log(`[Test] Final state: ${finalConv.turns.length} turns`);
    
    // Debug: Show all turns
    console.log('[Test] Final turns:');
    finalConv.turns.forEach((turn, i) => {
      console.log(`  ${i}: ${turn.agentId} - "${turn.content}"`);
    });
    
    // If agents already completed all messages before crash, that's OK
    // Just verify the conversation completed successfully
    if (before.turns.length === 10) {
      console.log('[Test] All turns completed before crash - verifying resurrection handled gracefully');
      expect(finalConv.turns.length).toBe(10);
    } else {
      // Verify we have more turns than before crash (showing agents continued)
      expect(finalConv.turns.length).toBeGreaterThan(before.turns.length);
    }
    
    // Get turns that happened after resurrection (new turns beyond what we had before)
    const turnsAfterResurrection = finalConv.turns.slice(before.turns.length);
    console.log(`[Test] Turns after resurrection: ${turnsAfterResurrection.length}`);
    turnsAfterResurrection.forEach((turn, i) => {
      console.log(`  Post-resurrection ${i}: ${turn.agentId} - "${turn.content}"`);
    });
    
    // If we had new turns after resurrection, ensure both agents participated
    if (turnsAfterResurrection.length > 0) {
      const agent1TurnsAfter = turnsAfterResurrection.filter(t => t.agentId === 'agent1');
      const agent2TurnsAfter = turnsAfterResurrection.filter(t => t.agentId === 'agent2');
      console.log(`[Test] Agent 1 turns after resurrection: ${agent1TurnsAfter.length}`);
      console.log(`[Test] Agent 2 turns after resurrection: ${agent2TurnsAfter.length}`);
      // At least one agent should have continued
      expect(agent1TurnsAfter.length + agent2TurnsAfter.length).toBeGreaterThanOrEqual(1);
    }
    
    // Each agent sends 5 messages total, so we should have 10
    expect(finalConv.turns.length).toBe(10);
    
    // Verify turn sequence
    expect(finalConv.turns[0].agentId).toBe('agent1');
    expect(finalConv.turns[0].content).toBe('Message 1 of 5');
    
    expect(finalConv.turns[1].agentId).toBe('agent2');
    expect(finalConv.turns[1].content).toBe('Message 1 of 5');
    
    expect(finalConv.turns[2].agentId).toBe('agent1');
    expect(finalConv.turns[2].content).toBe('Message 2 of 5');
    
    expect(finalConv.turns[3].agentId).toBe('agent2');
    expect(finalConv.turns[3].content).toBe('Message 2 of 5');
    
    expect(finalConv.turns[4].agentId).toBe('agent1');
    expect(finalConv.turns[4].content).toBe('Message 3 of 5');
    
    expect(finalConv.turns[5].agentId).toBe('agent2');
    expect(finalConv.turns[5].content).toBe('Message 3 of 5');
    
    // Clean up
    orchestrator2.close();
  }, 5000); // 5 second timeout for this test

  test('should handle mid-turn interruption with SimpleResumableAgent', async () => {
    const orchestrator1 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'mid-turn-test',
        conversationTitle: 'Test Mid-Turn Interruption'
      },
      agents: [
        {
          id: 'agent-a',
          strategyType: 'simple_resumable',
          shouldInitiateConversation: true
        },
        {
          id: 'agent-b',
          strategyType: 'simple_resumable'
        }
      ]
    };

    const { conversation } = await orchestrator1.createConversation(config);
    const conversationId = conversation.id;
    
    // Start conversation
    await orchestrator1.startConversation(conversationId);
    
    // Immediately close orchestrator while turn might be in progress
    await new Promise(resolve => setTimeout(resolve, 10));
    
    const beforeCrash = orchestrator1.getConversation(conversationId, true);
    const turnsBefore = beforeCrash.turns.length;
    console.log(`[Test] Turns before crash: ${turnsBefore}`);
    
    orchestrator1.close();
    
    // Create new orchestrator
    const orchestrator2 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    // Give resurrection time
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Verify conversation continues properly
    const afterResurrection = orchestrator2.getConversation(conversationId, true);
    console.log(`[Test] Turns after resurrection: ${afterResurrection.turns.length}`);
    
    // The agent should complete its 3 messages eventually
    await new Promise(resolve => setTimeout(resolve, 300));
    
    const finalConv = orchestrator2.getConversation(conversationId, true);
    console.log(`[Test] Final turns: ${finalConv.turns.length}`);
    
    // Should have 5 turns from each agent (10 total)
    expect(finalConv.turns.filter(t => t.agentId === 'agent-a').length).toBe(5);
    expect(finalConv.turns.filter(t => t.agentId === 'agent-b').length).toBe(5);
    
    // Verify messages are correct for agent-a
    const agentATurns = finalConv.turns.filter(t => t.agentId === 'agent-a');
    expect(agentATurns[0].content).toBe('Message 1 of 5');
    expect(agentATurns[1].content).toBe('Message 2 of 5');
    expect(agentATurns[2].content).toBe('Message 3 of 5');
    expect(agentATurns[3].content).toBe('Message 4 of 5');
    expect(agentATurns[4].content).toBe('Message 5 of 5');
    
    // Verify messages are correct for agent-b
    const agentBTurns = finalConv.turns.filter(t => t.agentId === 'agent-b');
    expect(agentBTurns[0].content).toBe('Message 1 of 5');
    expect(agentBTurns[1].content).toBe('Message 2 of 5');
    expect(agentBTurns[2].content).toBe('Message 3 of 5');
    expect(agentBTurns[3].content).toBe('Message 4 of 5');
    expect(agentBTurns[4].content).toBe('Message 5 of 5');
    
    // Clean up
    orchestrator2.close();
  }, 5000);

  test('should correctly track state across multiple resurrections', async () => {
    const orchestrator1 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    
    const config: CreateConversationRequest = {
      metadata: {
        scenarioId: 'multi-resurrection-test',
        conversationTitle: 'Test Multiple Resurrections'
      },
      agents: [
        {
          id: 'persistent-agent',
          strategyType: 'simple_resumable',
          shouldInitiateConversation: true
        },
        {
          id: 'responder-agent',
          strategyType: 'simple_resumable'
        }
      ]
    };

    const { conversation } = await orchestrator1.createConversation(config);
    const conversationId = conversation.id;
    
    // Start and let first message happen
    await orchestrator1.startConversation(conversationId);
    await new Promise(resolve => setTimeout(resolve, 150));
    
    const after1 = orchestrator1.getConversation(conversationId, true);
    console.log(`[Test] After first start: ${after1.turns.length} turns`);
    expect(after1.turns.length).toBeGreaterThanOrEqual(2);
    
    // First crash and resurrection
    orchestrator1.close();
    const orchestrator2 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    await new Promise(resolve => setTimeout(resolve, 200));
    
    const after2 = orchestrator2.getConversation(conversationId, true);
    console.log(`[Test] After first resurrection: ${after2.turns.length} turns`);
    expect(after2.turns.length).toBeGreaterThanOrEqual(after1.turns.length);
    
    // Let more messages happen
    await new Promise(resolve => setTimeout(resolve, 200));
    
    const beforeSecondCrash = orchestrator2.getConversation(conversationId, true);
    console.log(`[Test] Before second crash: ${beforeSecondCrash.turns.length} turns`);
    
    // Second crash and resurrection
    orchestrator2.close();
    const orchestrator3 = new ConversationOrchestrator(dbPath, mockLLMProvider);
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Let conversation complete
    await new Promise(resolve => setTimeout(resolve, 300));
    
    const finalConv = orchestrator3.getConversation(conversationId, true);
    console.log(`[Test] Final after multiple resurrections: ${finalConv.turns.length} turns`);
    
    // Should have exactly 10 turns (5 from each agent)
    expect(finalConv.turns.length).toBe(10);
    
    // Verify no duplicate messages
    const agent1Turns = finalConv.turns.filter(t => t.agentId === 'persistent-agent');
    const agent2Turns = finalConv.turns.filter(t => t.agentId === 'responder-agent');
    
    expect(agent1Turns.length).toBe(5);
    expect(agent2Turns.length).toBe(5);
    
    // Verify message sequence is correct
    expect(agent1Turns[0].content).toBe('Message 1 of 5');
    expect(agent1Turns[1].content).toBe('Message 2 of 5');
    expect(agent1Turns[2].content).toBe('Message 3 of 5');
    expect(agent1Turns[3].content).toBe('Message 4 of 5');
    expect(agent1Turns[4].content).toBe('Message 5 of 5');
    
    expect(agent2Turns[0].content).toBe('Message 1 of 5');
    expect(agent2Turns[1].content).toBe('Message 2 of 5');
    expect(agent2Turns[2].content).toBe('Message 3 of 5');
    expect(agent2Turns[3].content).toBe('Message 4 of 5');
    expect(agent2Turns[4].content).toBe('Message 5 of 5');
    
    // Clean up
    orchestrator3.close();
  }, 8000); // Longer timeout for multiple resurrections
});