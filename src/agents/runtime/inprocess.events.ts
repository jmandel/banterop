import type { IAgentEvents } from './runtime.interfaces';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { StreamEvent } from '$src/agents/clients/event-stream';

export class InProcessEvents implements IAgentEvents {
  constructor(
    private orchestrator: OrchestratorService,
    private conversationId: number,
    private includeGuidance = true
  ) {}

  subscribe(listener: (ev: StreamEvent) => void): () => void {
    // Subscribe to orchestrator events
    const subId = this.orchestrator.subscribe(
      this.conversationId,
      (event: StreamEvent) => {
        listener(event);
      },
      this.includeGuidance
    );

    // Return unsubscribe function
    return () => {
      this.orchestrator.unsubscribe(subId);
    };
  }
}