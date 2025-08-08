import type { ScheduleDecision, SchedulePolicy, SchedulePolicyInput } from '$src/types/orchestrator.types';

// A minimal policy that requires explicit agent metadata.
// No assumptions about agent IDs - all agents must be configured.
export class SimpleAlternationPolicy implements SchedulePolicy {
  decide({ snapshot, lastEvent }: SchedulePolicyInput): ScheduleDecision {
    // If no events yet, check if we have a configured starting agent
    if (!lastEvent) {
      const startingAgentId = snapshot.metadata?.startingAgentId;
      if (startingAgentId) {
        const metadataAgents = snapshot.metadata?.agents || [];
        const starter = metadataAgents.find(a => a.id === startingAgentId);
        if (starter) {
          if (starter.kind === 'internal') {
            return { kind: 'internal', agentId: startingAgentId };
          } else {
            return { kind: 'external', candidates: [startingAgentId], note: `Waiting for ${startingAgentId} to start` };
          }
        }
      }
      return { kind: 'none' };
    }

    // Only react to a message that finalized a turn
    if (lastEvent.type === 'message' && lastEvent.finality === 'turn') {
      // Use metadata.agents if available, otherwise fall back to discovering from history
      const metadataAgents = snapshot.metadata?.agents || [];
      let participants: Set<string>;
      let agentKindMap: Map<string, 'internal' | 'external'>;
      
      if (metadataAgents.length === 0) {
        // Without metadata, we cannot schedule agents
        return { kind: 'none' };
      }
      
      // Use metadata to know who's participating and their kinds
      participants = new Set(metadataAgents.map(a => a.id));
      agentKindMap = new Map(metadataAgents.map(a => [a.id, a.kind]));
      
      // Remove the last speaker to get potential next speakers
      const otherParticipants = Array.from(participants).filter(id => id !== lastEvent.agentId);
      
      if (otherParticipants.length === 0) {
        // No other participants configured
        return { kind: 'none' };
      }
      
      // Simple alternation: next speaker is the other participant
      // In a 2-agent conversation, this creates perfect alternation
      const nextAgent = otherParticipants[0]!;
      
      // Use metadata to determine if internal or external
      const isInternal = agentKindMap.get(nextAgent) === 'internal';
      
      if (isInternal) {
        return { kind: 'internal', agentId: nextAgent };
      } else {
        return { kind: 'external', candidates: [nextAgent], note: `Waiting for ${nextAgent}` };
      }
    }
    return { kind: 'none' };
  }
}