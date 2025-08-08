import type { ScheduleDecision, SchedulePolicy, SchedulePolicyInput } from '$src/types/orchestrator.types';
import type { ScenarioConfigAgentDetails } from '$src/types/scenario-configuration.types';
import type { AgentMeta } from '$src/types/conversation.meta';

export class ScenarioPolicy implements SchedulePolicy {
  decide({ snapshot, lastEvent }: SchedulePolicyInput): ScheduleDecision {
    // If no events yet, check if we have a configured starting agent
    if (!lastEvent) {
      const startingAgentId = snapshot.metadata?.startingAgentId;
      if (startingAgentId) {
        const metadataAgents = snapshot.metadata?.agents || [];
        const starter = metadataAgents.find((a: AgentMeta) => a.id === startingAgentId);
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
      // Check if this is a hydrated snapshot
      const hydrated = snapshot as any;
      
      if (hydrated.scenario) {
        // Use runtime metadata to determine agent kinds - MUST be explicitly configured
        const metadataAgents = snapshot.metadata?.agents || [];
        const agentKindMap = new Map(metadataAgents.map((a: AgentMeta) => [a.id, a.kind]));
        
        // Get scenario agents for participant list
        const scenarioAgents = (hydrated.scenario.agents || []) as ScenarioConfigAgentDetails[];
        
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
        // Without scenario, check metadata
        const metadataAgents = snapshot.metadata?.agents || [];
        
        if (metadataAgents.length === 0) {
          // No agent metadata configured
          return { kind: 'none' };
        }
        
        const agents = metadataAgents as AgentMeta[];
        const participants = new Set(agents.map(a => a.id));
        const agentKindMap = new Map(agents.map(a => [a.id, a.kind]));
        
        const otherParticipants = Array.from(participants).filter(id => id !== lastEvent.agentId);
        
        if (otherParticipants.length === 0) {
          return { kind: 'none' };
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