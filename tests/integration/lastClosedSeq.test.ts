import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { App } from '$src/server/app';

describe('lastClosedSeq per-conversation isolation', () => {
  let app: App;

  beforeEach(() => {
    app = new App({
      dbPath: ':memory:',
      nodeEnv: 'test',
      skipAutoRun: true
    });
  });

  test('lastClosedSeq should be 0 for new conversations, not global seq', async () => {
    const orchestrator = app.orchestrator;
    
    // Create first conversation and add a message
    const conv1 = orchestrator.createConversation({
      meta: {
        title: 'First conversation',
        agents: [{ id: 'user' }]
      }
    });
    
    // Send a message that closes a turn
    const result1 = orchestrator.sendMessage(conv1, 'user', { text: 'Hello conv1' }, 'turn');
    
    // Create second conversation  
    const conv2 = orchestrator.createConversation({
      meta: {
        title: 'Second conversation', 
        agents: [{ id: 'user' }]
      }
    });
    
    // Get snapshot for conv2
    const snapshot2 = orchestrator.getConversationSnapshot(conv2);
    
    // CRITICAL: lastClosedSeq for a new conversation should be 0, 
    // not the global seq from conv1's message
    expect(snapshot2.lastClosedSeq).toBe(0);
    
    // When an agent tries to respond in conv2, it should use precondition: { lastClosedSeq: 0 }
    // not precondition: { lastClosedSeq: result1.seq }
    
    // This should succeed with precondition 0
    const result2 = orchestrator.sendMessage(
      conv2, 
      'user', 
      { text: 'First message in conv2' }, 
      'turn'
    );
    
    expect(result2.turn).toBe(1);
    
    // Now conv2's lastClosedSeq should be the seq of its own message
    const snapshot2After = orchestrator.getConversationSnapshot(conv2);
    expect(snapshot2After.lastClosedSeq).toBe(result2.seq);
    
    // And conv1's lastClosedSeq should still be its own
    const snapshot1 = orchestrator.getConversationSnapshot(conv1);
    expect(snapshot1.lastClosedSeq).toBe(result1.seq);
    
    // Each conversation tracks its own lastClosedSeq (per-conversation seq)
    // Values may be the same across conversations (e.g., both 1) and that's expected.
  });

  test('multiple conversations should track lastClosedSeq independently', async () => {
    const orchestrator = app.orchestrator;
    
    // Create three conversations
    const convIds = [];
    for (let i = 0; i < 3; i++) {
      const id = orchestrator.createConversation({
        meta: {
          title: `Conversation ${i}`,
          agents: [{ id: 'agent' }]
        }
      });
      convIds.push(id);
    }
    
    // Send messages to each in different order
    const results = [];
    
    // Conv 2 gets first message
    results[2] = orchestrator.sendMessage(convIds[2]!, 'agent', { text: 'Conv 2 msg' }, 'turn');
    
    // Conv 0 gets second message  
    results[0] = orchestrator.sendMessage(convIds[0]!, 'agent', { text: 'Conv 0 msg' }, 'turn');
    
    // Conv 1 gets third message
    results[1] = orchestrator.sendMessage(convIds[1]!, 'agent', { text: 'Conv 1 msg' }, 'turn');
    
    // Each conversation should have its own lastClosedSeq
    for (let i = 0; i < 3; i++) {
      const snapshot = orchestrator.getConversationSnapshot(convIds[i]!);
      expect(snapshot.lastClosedSeq).toBe(results[i]!.seq);
    }
    
    // Now add a second turn to conv 0
    // It should use its own lastClosedSeq as precondition
    const conv0Snapshot = orchestrator.getConversationSnapshot(convIds[0]!);
    const secondMsg = orchestrator.sendMessage(
      convIds[0]!,
      'agent', 
      { text: 'Second message' },
      'turn',
      undefined // new turn
    );
    
    expect(secondMsg.turn).toBe(2);
    
    // Other conversations should be unaffected
    const conv1Snapshot = orchestrator.getConversationSnapshot(convIds[1]!);
    const conv2Snapshot = orchestrator.getConversationSnapshot(convIds[2]!);
    
    expect(conv1Snapshot.lastClosedSeq).toBe(results[1]!.seq);
    expect(conv2Snapshot.lastClosedSeq).toBe(results[2]!.seq);
  });

  test('turns should increment correctly without preconditions', async () => {
    const orchestrator = app.orchestrator;
    
    const conv = orchestrator.createConversation({
      meta: {
        title: 'Test conversation',
        agents: [{ id: 'agent' }]
      }
    });
    
    // First message creates turn 1
    const msg1 = orchestrator.sendMessage(conv, 'agent', { text: 'First' }, 'turn');
    expect(msg1.turn).toBe(1);
    
    // Second message creates turn 2 (since first had finality='turn')
    const msg2 = orchestrator.sendMessage(
      conv,
      'agent',
      { text: 'Second' },
      'turn'
    );
    expect(msg2.turn).toBe(2);
    
    // Third message creates turn 3
    const msg3 = orchestrator.sendMessage(
      conv,
      'agent',
      { text: 'Third' },
      'turn'
    );
    expect(msg3.turn).toBe(3);
  });

  afterEach(async () => {
    await app.shutdown();
  });
});
