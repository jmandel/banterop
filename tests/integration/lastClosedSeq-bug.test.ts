import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EventStore } from '$src/db/event.store';
import { ConversationStore } from '$src/db/conversation.store';
import { AttachmentStore } from '$src/db/attachment.store';
import { IdempotencyStore } from '$src/db/idempotency.store';
import { ScenarioStore } from '$src/db/scenario.store';
import { SCHEMA_SQL } from '$src/db/schema.sql';

describe('lastClosedSeq bug reproduction', () => {
  test('getHead should return lastClosedSeq PER conversation, not global', () => {
    // Create fresh in-memory database
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    
    const eventStore = new EventStore(db);
    const convStore = new ConversationStore(db);
    
    // Create first conversation
    const conv1Id = convStore.create({
      meta: {
        title: 'Conv 1',
        description: 'First conversation',
        agents: [{ id: 'user' }]
      }
    });
    
    // Add a message to conv1 that closes turn 1
    const result1 = eventStore.appendEvent({
      conversation: conv1Id,
      type: 'message',
      payload: { text: 'Message in conv1' },
      finality: 'turn',
      agentId: 'user'
    });
    
    console.log(`Conv1: Added message with seq=${result1.seq}, turn=${result1.turn}`);
    
    // Check head for conv1
    const head1 = eventStore.getHead(conv1Id);
    console.log(`Conv1 head: lastTurn=${head1.lastTurn}, lastClosedSeq=${head1.lastClosedSeq}`);
    
    // Create second conversation
    const conv2Id = convStore.create({
      meta: {
        title: 'Conv 2',
        description: 'Second conversation',
        agents: [{ id: 'user' }]
      }
    });
    
    // Check head for conv2 BEFORE any messages
    const head2Before = eventStore.getHead(conv2Id);
    console.log(`Conv2 head (before any messages): lastTurn=${head2Before.lastTurn}, lastClosedSeq=${head2Before.lastClosedSeq}`);
    
    // This should be 0, not result1.seq!
    expect(head2Before.lastClosedSeq).toBe(0);
    expect(head2Before.lastTurn).toBe(0);
    
    // Add a message to conv2
    const result2 = eventStore.appendEvent({
      conversation: conv2Id,
      type: 'message',
      payload: { text: 'Message in conv2' },
      finality: 'turn',
      agentId: 'user'
    });
    
    console.log(`Conv2: Added message with seq=${result2.seq}, turn=${result2.turn}`);
    
    // Check head for conv2 after message
    const head2After = eventStore.getHead(conv2Id);
    console.log(`Conv2 head (after message): lastTurn=${head2After.lastTurn}, lastClosedSeq=${head2After.lastClosedSeq}`);
    
    // Conv2's lastClosedSeq should be its own message's seq
    expect(head2After.lastClosedSeq).toBe(result2.seq);
    
    // Create third conversation to really test isolation
    const conv3Id = convStore.create({
      meta: {
        title: 'Conv 3',
        description: 'Third conversation',
        agents: [{ id: 'user' }]
      }
    });
    
    // Add TWO turns to conv3
    const result3a = eventStore.appendEvent({
      conversation: conv3Id,
      type: 'message',
      payload: { text: 'First message in conv3' },
      finality: 'turn',
      agentId: 'user'
    });
    
    console.log(`Conv3: First message seq=${result3a.seq}, turn=${result3a.turn}`);
    
    const result3b = eventStore.appendEvent({
      conversation: conv3Id,
      type: 'message', 
      payload: { text: 'Second message in conv3' },
      finality: 'turn',
      agentId: 'user'
    });
    
    console.log(`Conv3: Second message seq=${result3b.seq}, turn=${result3b.turn}`);
    
    // Check all heads
    const finalHead1 = eventStore.getHead(conv1Id);
    const finalHead2 = eventStore.getHead(conv2Id);
    const finalHead3 = eventStore.getHead(conv3Id);
    
    console.log('\nFinal state:');
    console.log(`Conv1: lastTurn=${finalHead1.lastTurn}, lastClosedSeq=${finalHead1.lastClosedSeq}`);
    console.log(`Conv2: lastTurn=${finalHead2.lastTurn}, lastClosedSeq=${finalHead2.lastClosedSeq}`);
    console.log(`Conv3: lastTurn=${finalHead3.lastTurn}, lastClosedSeq=${finalHead3.lastClosedSeq}`);
    
    // Each conversation should track its OWN lastClosedSeq
    expect(finalHead1.lastClosedSeq).toBe(result1.seq);
    expect(finalHead2.lastClosedSeq).toBe(result2.seq);
    expect(finalHead3.lastClosedSeq).toBe(result3b.seq); // The second message in conv3
    
    // They should all be different (global autoincrement)
    expect(finalHead1.lastClosedSeq).not.toBe(finalHead2.lastClosedSeq);
    expect(finalHead2.lastClosedSeq).not.toBe(finalHead3.lastClosedSeq);
    expect(finalHead1.lastClosedSeq).not.toBe(finalHead3.lastClosedSeq);
    
    db.close();
  });

  test('getHead implementation check', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    
    // Directly check what the SQL query returns
    const conv1 = 1;
    const conv2 = 2;
    
    // Insert conversations directly
    db.prepare(`
      INSERT INTO conversations (conversation, meta_json, status)
      VALUES (?, ?, ?)
    `).run(conv1, '{"title":"Conv1","agents":[]}', 'active');
    
    db.prepare(`
      INSERT INTO conversations (conversation, meta_json, status)
      VALUES (?, ?, ?)
    `).run(conv2, '{"title":"Conv2","agents":[]}', 'active');
    
    // Add message to conv1 with seq=100 (simulating global autoincrement)
    db.prepare(`
      INSERT INTO conversation_events (conversation, turn, event, type, payload, finality, agent_id, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(conv1, 1, 1, 'message', '{"text":"msg1"}', 'turn', 'user', 100);
    
    // Query what getHead would return for conv2 (which has no events)
    const query = db.prepare(`
      SELECT 
        COALESCE(MAX(CASE WHEN type = 'message' AND finality != 'none' THEN seq END), 0) as lastClosedSeq,
        COALESCE(MAX(turn), 0) as lastTurn
      FROM conversation_events 
      WHERE conversation = ?
    `);
    
    const conv2Head = query.get(conv2) as { lastClosedSeq: number; lastTurn: number };
    console.log(`Conv2 head from SQL: lastClosedSeq=${conv2Head.lastClosedSeq}, lastTurn=${conv2Head.lastTurn}`);
    
    // This MUST be 0, not 100!
    expect(conv2Head.lastClosedSeq).toBe(0);
    expect(conv2Head.lastTurn).toBe(0);
    
    // Now add a message to conv2 with seq=101
    db.prepare(`
      INSERT INTO conversation_events (conversation, turn, event, type, payload, finality, agent_id, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(conv2, 1, 1, 'message', '{"text":"msg2"}', 'turn', 'user', 101);
    
    const conv2HeadAfter = query.get(conv2) as { lastClosedSeq: number; lastTurn: number };
    console.log(`Conv2 head after message: lastClosedSeq=${conv2HeadAfter.lastClosedSeq}, lastTurn=${conv2HeadAfter.lastTurn}`);
    
    expect(conv2HeadAfter.lastClosedSeq).toBe(101);
    expect(conv2HeadAfter.lastTurn).toBe(1);
    
    // Conv1 should still have its own lastClosedSeq
    const conv1Head = query.get(conv1) as { lastClosedSeq: number; lastTurn: number };
    expect(conv1Head.lastClosedSeq).toBe(100);
    
    db.close();
  });
});