import type { OrchestratorControl } from './orchestrator-control';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import { AgentHost } from '$src/server/agent-host';

export class InProcessControl implements OrchestratorControl {
  constructor(private orch: OrchestratorService, private host: AgentHost) {}

  async createConversation(meta: any) { 
    return this.orch.createConversation({ meta }); 
  }

  async getConversation(id: number, opts?: { includeScenario?: boolean }) { 
    return this.orch.getConversationSnapshot(id, opts); 
  }

  async ensureAgentsRunning(conversationId: number, agentIds?: string[]) {
    await this.host.ensure(conversationId, { agentIds });
    const ensured = this.host.list(conversationId).map(a => ({ id: a.id, class: a.class }));
    return { ensured };
  }

  async stopAgents(conversationId: number) { 
    await this.host.stop(conversationId); 
  }
}

