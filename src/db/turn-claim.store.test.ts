import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Sqlite } from './sqlite';
import { TurnClaimStore } from './turn-claim.store';

describe('TurnClaimStore', () => {
  let sqlite: Sqlite;
  let store: TurnClaimStore;

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.migrate();
    store = new TurnClaimStore(sqlite.raw);
    
    // Seed conversation for FK constraint
    sqlite.raw.prepare(`INSERT INTO conversations (conversation, status) VALUES (1, 'active')`).run();
  });

  afterEach(() => sqlite.close());

  it('claims turn successfully on first attempt', () => {
    const expiresAt = new Date(Date.now() + 30000).toISOString();
    const claimed = store.claim({
      conversation: 1,
      guidanceSeq: 1.1,
      agentId: 'agent-a',
      expiresAt,
    });
    
    expect(claimed).toBe(true);
    
    const claim = store.getClaim(1, 1.1);
    expect(claim).toBeDefined();
    expect(claim?.agentId).toBe('agent-a');
  });

  it('prevents duplicate claims for same guidance', () => {
    const expiresAt = new Date(Date.now() + 30000).toISOString();
    
    // First claim succeeds
    const first = store.claim({
      conversation: 1,
      guidanceSeq: 1.1,
      agentId: 'agent-a',
      expiresAt,
    });
    expect(first).toBe(true);
    
    // Second claim by different agent fails
    const second = store.claim({
      conversation: 1,
      guidanceSeq: 1.1,
      agentId: 'agent-b',
      expiresAt,
    });
    expect(second).toBe(false);
    
    // Verify original claim is preserved
    const claim = store.getClaim(1, 1.1);
    expect(claim?.agentId).toBe('agent-a');
  });

  it('allows same agent to reclaim (idempotent)', () => {
    const expiresAt = new Date(Date.now() + 30000).toISOString();
    
    const first = store.claim({
      conversation: 1,
      guidanceSeq: 1.1,
      agentId: 'agent-a',
      expiresAt,
    });
    expect(first).toBe(true);
    
    const second = store.claim({
      conversation: 1,
      guidanceSeq: 1.1,
      agentId: 'agent-a',
      expiresAt,
    });
    expect(second).toBe(false); // Still returns false but orchestrator handles this case
  });

  it('cleans up expired claims', () => {
    // Create an already-expired claim
    const expired = new Date(Date.now() - 1000).toISOString();
    store.claim({
      conversation: 1,
      guidanceSeq: 1.1,
      agentId: 'agent-a',
      expiresAt: expired,
    });
    
    // Create a valid claim
    const valid = new Date(Date.now() + 30000).toISOString();
    store.claim({
      conversation: 1,
      guidanceSeq: 2.1,
      agentId: 'agent-b',
      expiresAt: valid,
    });
    
    // Get expired before deletion
    const expiredList = store.getExpired();
    expect(expiredList.length).toBe(1);
    expect(expiredList[0]?.guidanceSeq).toBe(1.1);
    
    // Delete expired
    const deleted = store.deleteExpired();
    expect(deleted).toBe(1);
    
    // Verify only valid claim remains
    expect(store.getClaim(1, 1.1)).toBeNull();
    expect(store.getClaim(1, 2.1)).toBeDefined();
  });

  it('gets active claims for conversation', () => {
    const future = new Date(Date.now() + 30000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    
    store.claim({ conversation: 1, guidanceSeq: 1.1, agentId: 'a', expiresAt: future });
    store.claim({ conversation: 1, guidanceSeq: 2.1, agentId: 'b', expiresAt: past });
    store.claim({ conversation: 1, guidanceSeq: 3.1, agentId: 'c', expiresAt: future });
    
    const active = store.getActiveClaimsForConversation(1);
    expect(active.length).toBe(2);
    expect(active[0]?.guidanceSeq).toBe(3.1); // Ordered DESC
    expect(active[1]?.guidanceSeq).toBe(1.1);
  });
});