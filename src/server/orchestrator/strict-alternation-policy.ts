import type { ScheduleDecision, SchedulePolicy, SchedulePolicyInput } from '$src/types/orchestrator.types';

export class StrictAlternationPolicy implements SchedulePolicy {
  decide({ snapshot, lastEvent }: SchedulePolicyInput): ScheduleDecision {
    // Only switch on message events that end a turn or conversation
    if (!lastEvent ||
        lastEvent.type !== 'message' ||
        (lastEvent.finality !== 'turn' && lastEvent.finality !== 'conversation')) {
      return { kind: 'none' };
    }

    const agents = snapshot.metadata.agents.map(a => a.id);
    if (agents.length < 2) return { kind: 'none' };

    const currentIdx = agents.indexOf(lastEvent.agentId);
    if (currentIdx === -1) return { kind: 'none' };

    const nextIdx = (currentIdx + 1) % agents.length;
    const nextId = agents[nextIdx];
    if (!nextId) return { kind: 'none' };
    
    const nextMeta = snapshot.metadata.agents.find(a => a.id === nextId);
    if (!nextMeta) return { kind: 'none' };

    // Location is runtime decision - just indicate which agent should go
    return { kind: 'agent', agentId: nextId, note: `Next turn: ${nextId}` };
  }
}