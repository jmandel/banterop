import type { ScheduleDecision, SchedulePolicy, SchedulePolicyInput } from '$src/types/orchestrator.types';

/**
 * Competition policy for testing turn claim mechanics.
 * When user speaks, it creates guidance for a generic "responder" role
 * that multiple agents can compete to claim.
 */
export class CompetitionPolicy implements SchedulePolicy {
  decide({ snapshot, lastEvent }: SchedulePolicyInput): ScheduleDecision {
    if (!lastEvent) return { kind: 'none' };

    // Only react to a message that finalized a turn
    if (lastEvent.type === 'message' && lastEvent.finality === 'turn') {
      const metadataAgents = snapshot.metadata?.agents || [];
      
      if (metadataAgents.length === 0) {
        return { kind: 'none' };
      }

      // If user spoke, pick the first competitor agent to create guidance for
      if (lastEvent.agentId === 'user') {
        // Find a competitor agent to schedule
        const competitorAgent = metadataAgents.find(a => 
          a.id.startsWith('competitor-')
        );
        if (competitorAgent) {
          // Create guidance for the first competitor
          return { kind: 'agent', agentId: competitorAgent.id };
        }
      }
      
      // For non-user agents, schedule user
      if (lastEvent.agentId !== 'user') {
        const userAgent = metadataAgents.find(a => a.id === 'user');
        if (userAgent) {
          return { kind: 'agent', agentId: 'user', note: 'Waiting for user' };
        }
      }
    }
    
    return { kind: 'none' };
  }
}