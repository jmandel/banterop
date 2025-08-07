import type { OrchestratorService } from './orchestrator';

// Stateless worker that performs exactly one turn.
// In real life this would call LLMs/tools; here we stub with a simple echo behavior.
export class WorkerRunner {
  constructor(private orchestrator: OrchestratorService) {}

  async runOneTurn(conversation: number, agentId: string): Promise<void> {
    // Start new turn with a non-final message
    this.orchestrator.sendMessage(conversation, agentId, { text: 'Processing...' }, 'none');

    // Recompute to find the turn we just opened
    const snap = this.orchestrator.getConversationSnapshot(conversation);
    const currentTurn = snap.events[snap.events.length - 1]!.turn;

    this.orchestrator.sendTrace(conversation, agentId, { 
      type: 'thought', 
      content: `Agent ${agentId} is preparing a reply` 
    }, currentTurn);

    this.orchestrator.sendMessage(conversation, agentId, { 
      text: 'This is a placeholder response from internal worker' 
    }, 'turn', currentTurn);
  }
}