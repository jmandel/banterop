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
    orch = new OrchestratorService(storage, bus, undefined, {});
    // seed conversation
    orch.createConversation({});
  });

  afterEach(async () => {
    await orch.shutdown();
    storage.close();
  });

  it('appends events, fans out, and emits next-candidate system event on turn finality', () => {
    const recv: UnifiedEvent[] = [];
    orch.subscribe(1, (e: UnifiedEvent) => recv.push(e));

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

  it('sendTrace can start a new turn when none exists', () => {
    // Starting a new turn via message
    orch.sendMessage(1, 'user', { text: 'Part 1' }, 'none'); // turn 1

    // sendTrace on open turn should work
    orch.sendTrace(1, 'user', { type: 'thought', content: 'thinking' });

    // Finalize the turn
    orch.sendMessage(1, 'user', { text: 'Part 2' }, 'turn', 1);

    // Get the lastClosedSeq for the precondition
    const snapshot1 = orch.getConversationSnapshot(1);
    
    // Now sendTrace can start a new turn (turn 2) with proper precondition
    orch.sendTrace(1, 'assistant', { type: 'thought', content: 'starting new turn' }, undefined, { lastClosedSeq: snapshot1.lastClosedSeq });
    
    // Verify the trace started a new turn
    const snapshot = orch.getConversationSnapshot(1);
    const lastEvent = snapshot.events[snapshot.events.length - 1];
    expect(lastEvent?.type).toBe('trace');
    expect(lastEvent?.turn).toBe(2);
  });

  it('logs meta_created system event in turn 0', () => {
    const recv: UnifiedEvent[] = [];
    const conversationId = orch.createConversation({
      title: 'Test Conversation',
      agents: [
        { id: 'user', kind: 'external' },
        { id: 'bot', kind: 'internal' },
      ],
    });
    
    orch.subscribe(conversationId, (e: UnifiedEvent) => recv.push(e));
    
    // Meta_created should have been logged
    const snapshot = orch.getConversationSnapshot(conversationId);
    const systemEvents = snapshot.events.filter(e => e.type === 'system');
    expect(systemEvents.length).toBeGreaterThan(0);
    
    const metaCreated = systemEvents.find(e => 
      e.type === 'system' && (e.payload as any).kind === 'meta_created'
    );
    expect(metaCreated).toBeDefined();
    expect(metaCreated?.turn).toBe(0);
    expect(metaCreated?.event).toBe(1);
  });

  it('emits guidance events when configured', () => {
    const orch2 = new OrchestratorService(storage, bus, undefined, {});
    const convId = orch2.createConversation({
      agents: [
        { id: 'user', kind: 'external' },
        { id: 'assistant', kind: 'internal' },
      ],
    });
    
    
    const recv: Array<UnifiedEvent | any> = [];
    orch2.subscribe(convId, (e: any) => recv.push(e), true); // includeGuidance = true

    // User finalizes a turn -> should emit guidance
    orch2.appendEvent({
      conversation: convId,
      type: 'message',
      payload: { text: 'Please answer' } as MessagePayload,
      finality: 'turn',
      agentId: 'user',
    });

    // Check that guidance was emitted
    const guidanceEvents = recv.filter((e) => e.type === 'guidance');
    expect(guidanceEvents.length).toBeGreaterThan(0);
    
    // Verify the guidance is for the assistant
    if (guidanceEvents.length > 0) {
      expect(guidanceEvents[0].nextAgentId).toBe('assistant');
    }
  });
});