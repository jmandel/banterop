import { describe, it, expect } from 'bun:test';
import { Storage } from '$src/server/orchestrator/storage';
import { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import { ConversationWatchdog } from '$src/server/watchdog/conversation-watchdog';

// Minimal mock for lifecycle manager
const lifecycleManager = {
  stop: async (_conversationId: number) => { /* no-op */ },
} as unknown as import('$src/server/control/server-agent-lifecycle').ServerAgentLifecycleManager;

describe('Watchdog cancellation targets next valid turn even if last event is system', () => {
  it('appends cancellation on next turn when last non-system turn is closed', async () => {
    const storage = new Storage(':memory:');
    const orchestrator = new OrchestratorService(storage);
    try {
      // Create a conversation and backdate createdAt to bypass MIN_AGE_MS
      const conversationId = storage.conversations.create({
        meta: { title: 'wd-test', agents: [] }
      } as any);
      // Backdate createdAt by 10 minutes
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      storage.db.prepare(`UPDATE conversations SET created_at = ? WHERE conversation = ?`).run(tenMinutesAgo, conversationId);

      // Close turn 1
      storage.events.appendEvent({
        conversation: conversationId,
        turn: 1,
        type: 'message',
        payload: { text: 't1 done' },
        finality: 'turn',
        agentId: 'tester',
      });

      // Append a system event after closing t1
      storage.events.appendEvent({
        conversation: conversationId,
        turn: 0,
        type: 'system',
        payload: { kind: 'note', data: { msg: 'post t1' } },
        finality: 'none',
        agentId: 'system',
      });

      // Sanity: head should reflect lastTurn=1 (closed), hasOpenTurn=false
      const headBefore = storage.events.getHead(conversationId);
      expect(headBefore.lastTurn).toBe(1);
      expect(headBefore.hasOpenTurn).toBe(false);

      // Construct watchdog with zero threshold so stall condition is true
      const watchdog = new ConversationWatchdog(
        storage,
        orchestrator,
        lifecycleManager,
        60_000, // intervalMs (unused in direct call)
        0       // stalledThresholdMs => any timeSinceLastEvent > 0 counts
      );

      // Call the private method via any to target a single conversation
      await (watchdog as any).cancelStalledConversation(conversationId);

      // Verify a conversation-final message was appended on turn 2
      const events = storage.events.getEvents(conversationId);
      const finalMsg = events.find(e => e.type === 'message' && e.finality === 'conversation');
      expect(finalMsg).toBeTruthy();
      expect(finalMsg!.turn).toBe(2);
    } finally {
      storage.close();
    }
  });
});

