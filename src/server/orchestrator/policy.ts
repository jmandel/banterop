import type { ScheduleDecision, SchedulePolicy, SchedulePolicyInput } from '$src/types/orchestrator.types';

// A minimal policy:
// - If the last event finalized a turn and the last speaker was "user",
//   schedule an internal "assistant" agent.
// - Otherwise, emit advisory external candidates (none by default).
// For testing, also supports alternating between agent-a and agent-b
export class SimpleAlternationPolicy implements SchedulePolicy {
  decide({ snapshot, lastEvent }: SchedulePolicyInput): ScheduleDecision {
    if (!lastEvent) return { kind: 'none' };

    // Only react to a message that finalized a turn
    if (lastEvent.type === 'message' && lastEvent.finality === 'turn') {
      // Use metadata.agents if available, otherwise fall back to discovering from history
      const metadataAgents = snapshot.metadata?.agents || [];
      let participants: Set<string>;
      let agentKindMap: Map<string, 'internal' | 'external'>;
      
      if (metadataAgents.length > 0) {
        // Use metadata to know who's participating and their kinds
        participants = new Set(metadataAgents.map(a => a.id));
        agentKindMap = new Map(metadataAgents.map(a => [a.id, a.kind]));
      } else {
        // Fall back to discovering from conversation history
        participants = new Set<string>();
        agentKindMap = new Map();
        
        for (const event of snapshot.events) {
          if (event.type === 'message' && event.agentId !== 'system-orchestrator') {
            participants.add(event.agentId);
            // Guess kind based on naming convention
            const kind = event.agentId.startsWith('agent-') || event.agentId === 'assistant' ? 'internal' : 'external';
            agentKindMap.set(event.agentId, kind);
          }
        }
      }
      
      // Remove the last speaker to get potential next speakers
      const otherParticipants = Array.from(participants).filter(id => id !== lastEvent.agentId);
      
      if (otherParticipants.length === 0) {
        // No one else defined yet
        if (lastEvent.agentId === 'user') {
          // User spoke first, check if we have internal agents defined
          const internalAgent = metadataAgents.find(a => a.kind === 'internal');
          if (internalAgent) {
            return { kind: 'internal', agentId: internalAgent.id };
          }
          // Fall back to generic 'assistant' role
          return { kind: 'internal', agentId: 'assistant' };
        }
        return { kind: 'external', candidates: ['user'], note: 'Waiting for other participant' };
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