import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import { AgentHost } from './agent-host';

export async function resumeActiveConversations(orch: OrchestratorService, host: AgentHost) {
  const actives = orch.listConversations({ status: 'active' });
  for (const c of actives) {
    const meta = c.metadata as any;
    if (meta?.custom?.autoRun) {
      const agentIds: string[] | undefined = meta?.custom?.autoRunAgents;
      await host.ensure(c.conversation, { agentIds });
    }
  }
}

