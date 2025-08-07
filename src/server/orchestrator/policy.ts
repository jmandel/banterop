import type { ScheduleDecision, SchedulePolicy, SchedulePolicyInput } from '$src/types/orchestrator.types';

// A minimal policy:
// - If the last event finalized a turn and the last speaker was "user",
//   schedule an internal "assistant" agent.
// - Otherwise, emit advisory external candidates (none by default).
export class SimpleAlternationPolicy implements SchedulePolicy {
  constructor(private internalAgents: string[] = ['assistant']) {}

  decide({ snapshot: _snapshot, lastEvent }: SchedulePolicyInput): ScheduleDecision {
    if (!lastEvent) return { kind: 'none' };

    // Only react to a message that finalized a turn
    if (lastEvent.type === 'message' && lastEvent.finality === 'turn') {
      // If last actor is not one of our internal agents, schedule the first internal agent
      if (!this.internalAgents.includes(lastEvent.agentId)) {
        return { kind: 'internal', agentId: this.internalAgents[0]! };
      } else {
        // If last actor is internal, let externals (like "user") reply
        return { kind: 'external', candidates: ['user'], note: 'Waiting for external response' };
      }
    }
    return { kind: 'none' };
  }
}