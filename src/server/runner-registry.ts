import type { Database } from 'bun:sqlite';
import type { AgentHost } from '$src/server/agent-host';

export class RunnerRegistry {
  constructor(private db: Database, private host: AgentHost) {}

  async ensureAgentsRunningOnServer(conversationId: number, agentIds: string[]): Promise<{ ensured: Array<{ id: string; class?: string }> }> {
    console.log('[RunnerRegistry] ensureAgentsRunningOnServer', { conversationId, agentIds });
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO runner_registry (conversation_id, agent_id) VALUES (?, ?)`
    );
    const tx = this.db.transaction(() => {
      for (const id of agentIds) stmt.run(conversationId, id);
    });
    tx();
    // Start and wait for handle registration so list() reflects state
    await this.host.ensure(conversationId, { agentIds });
    const ensured = this.host.list(conversationId);
    console.log('[RunnerRegistry] ensured agents', { conversationId, ensured });
    return { ensured };
  }

  async stopAgentsOnServer(conversationId: number, agentIds?: string[]): Promise<{ ok: true }> {
    if (Array.isArray(agentIds) && agentIds.length > 0) {
      const del = this.db.prepare(
        `DELETE FROM runner_registry WHERE conversation_id = ? AND agent_id = ?`
      );
      const tx = this.db.transaction(() => {
        for (const id of agentIds) del.run(conversationId, id);
      });
      tx();
    } else {
      this.db.prepare(`DELETE FROM runner_registry WHERE conversation_id = ?`).run(conversationId);
    }
    await this.host.stop(conversationId);
    return { ok: true };
  }

  async resumeAgentsFromLocalRegistryOnServer(): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT conversation_id as conversationId, agent_id as agentId FROM runner_registry`
      )
      .all() as Array<{ conversationId: number; agentId: string }>;
    const byConv = new Map<number, string[]>();
    for (const r of rows) {
      if (!byConv.has(r.conversationId)) byConv.set(r.conversationId, []);
      byConv.get(r.conversationId)!.push(r.agentId);
    }
    for (const [conversationId, agentIds] of byConv) {
      await this.host.ensure(conversationId, { agentIds });
    }
  }
}
