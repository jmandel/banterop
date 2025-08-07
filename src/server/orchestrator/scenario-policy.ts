import type { ScheduleDecision, SchedulePolicy, SchedulePolicyInput } from '$src/types/orchestrator.types';
import type { AgentDefinition } from '$src/types/scenario-configuration.types';
import type { AgentMeta } from '$src/types/conversation.meta';

export class ScenarioPolicy implements SchedulePolicy {
  decide({ snapshot, lastEvent }: SchedulePolicyInput): ScheduleDecision {
    if (!lastEvent) return { kind: 'none' };

    // Only react to a message that finalized a turn
    if (lastEvent.type === 'message' && lastEvent.finality === 'turn') {
      // Check if this is a hydrated snapshot
      const hydrated = snapshot as any;
      
      if (hydrated.scenario) {
        // Use scenario agents to determine participants and their kinds
        const scenarioAgents = (hydrated.scenario.agents || []) as AgentDefinition[];
        const agentKindMap = new Map(scenarioAgents.map(a => [a.agentId, a.role === 'assistant' ? 'internal' : 'external']));
        
        // Get participants from scenario
        const participants = new Set(scenarioAgents.map(a => a.agentId));
        
        // Remove the last speaker to get potential next speakers
        const otherParticipants = Array.from(participants).filter(id => id !== lastEvent.agentId);
        
        if (otherParticipants.length === 0) {
          // No one else to speak
          return { kind: 'none' };
        }
        
        // Simple alternation: next speaker is the first other participant
        const nextAgent = String(otherParticipants[0]!);
        const isInternal = agentKindMap.get(nextAgent) === 'internal';
        
        if (isInternal) {
          return { kind: 'internal', agentId: nextAgent };
        } else {
          return { kind: 'external', candidates: [nextAgent], note: `Waiting for ${nextAgent}` };
        }
      } else {
        // Fall back to simple alternation based on metadata
        const metadataAgents = snapshot.metadata?.agents || [];
        let participants: Set<string>;
        let agentKindMap: Map<string, 'internal' | 'external'>;
        
        if (metadataAgents.length > 0) {
          const agents = metadataAgents as AgentMeta[];
          participants = new Set(agents.map(a => a.id));
          agentKindMap = new Map(agents.map(a => [a.id, a.kind]));
        } else {
          // Discover from conversation history
          participants = new Set<string>();
          agentKindMap = new Map();
          
          for (const event of snapshot.events) {
            if (event.type === 'message' && event.agentId !== 'system-orchestrator') {
              participants.add(event.agentId);
              const kind = event.agentId.startsWith('agent-') || event.agentId === 'assistant' ? 'internal' : 'external';
              agentKindMap.set(event.agentId, kind);
            }
          }
        }
        
        const otherParticipants = Array.from(participants).filter(id => id !== lastEvent.agentId);
        
        if (otherParticipants.length === 0) {
          if (lastEvent.agentId === 'user') {
            return { kind: 'internal', agentId: 'assistant' };
          }
          return { kind: 'external', candidates: ['user'], note: 'Waiting for other participant' };
        }
        
        const nextAgent = String(otherParticipants[0]!);
        const isInternal = agentKindMap.get(nextAgent) === 'internal';
        
        if (isInternal) {
          return { kind: 'internal', agentId: nextAgent };
        } else {
          return { kind: 'external', candidates: [nextAgent], note: `Waiting for ${nextAgent}` };
        }
      }
    }
    
    return { kind: 'none' };
  }
}