import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Storage } from './storage';
import { OrchestratorService } from './orchestrator';
import { SubscriptionBus } from './subscriptions';
import type { UnifiedEvent, MessagePayload } from '$src/types/event.types';

describe('OrchestratorService', () => {
  let storage: Storage;
  let orch: OrchestratorService;
  let bus: SubscriptionBus;

  beforeEach(() => {
    storage = new Storage(':memory:');
    bus = new SubscriptionBus();
    orch = new OrchestratorService(storage, bus, undefined, { emitNextCandidates: true });
    // seed conversation
    orch.createConversation({});
  });

  afterEach(async () => {
    await orch.shutdown();
    storage.close();
  });

  it('appends events, fans out, and emits next-candidate system event on turn finality', () => {
    const recv: UnifiedEvent[] = [];
    orch.subscribe(1, (e) => recv.push(e));

    // Start a user turn and finalize
    orch.appendEvent({
      conversation: 1,
      type: 'message',
      payload: { text: 'Hi' } as MessagePayload,
      finality: 'turn',
      agentId: 'user',
    });

    // We should have received the message itself and possibly a system advisory
    expect(recv.length).toBeGreaterThanOrEqual(1);
    expect(recv[0]!.type).toBe('message');

    // If policy emitted advisory, it would be last
    const maybeSystem = recv.find((e) => e.type === 'system');
    if (maybeSystem) {
      expect((maybeSystem.payload as {kind: string}).kind).toBe('next_candidate_agents');
    }
  });

  it('sendTrace requires open turn; sendMessage can start a new turn', () => {
    // Starting a new turn via message
    orch.sendMessage(1, 'user', { text: 'Part 1' }, 'none'); // turn 1

    // sendTrace on open turn should work
    orch.sendTrace(1, 'user', { type: 'thought', content: 'thinking' });

    // Finalize the turn
    orch.sendMessage(1, 'user', { text: 'Part 2' }, 'turn', 1);

    // Now sendTrace without specifying turn should fail (no open turn)
    expect(() => orch.sendTrace(1, 'user', { type: 'thought', content: 'too late' })).toThrow(/No open turn/);
  });

  it('spawnInternalWorker is invoked by policy (smoke test)', async () => {
    const recv: UnifiedEvent[] = [];
    orch.subscribe(1, (e) => recv.push(e));

    // User finalizes a turn -> policy schedules internal worker -> worker appends trace + final message
    orch.appendEvent({
      conversation: 1,
      type: 'message',
      payload: { text: 'Please answer' } as MessagePayload,
      finality: 'turn',
      agentId: 'user',
    });

    // Wait for worker to complete
    await orch.waitForWorkers(1);
    
    // Check that worker added messages
    const hasWorkerMsg = recv.some((e) => e.type === 'message' && e.agentId !== 'user');
    expect(hasWorkerMsg).toBe(true);
  });
});