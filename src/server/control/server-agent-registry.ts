import type { Database } from 'bun:sqlite';
import type { IAgentRegistry } from '$src/control/agent-lifecycle.interfaces';

export class ServerAgentRegistry implements IAgentRegistry {
  constructor(private db: Database) {}

  async register(conversationId: number, agentIds: string[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO runner_registry (conversation_id, agent_id) VALUES (?, ?)`
    );
    const tx = this.db.transaction(() => {
      for (const id of agentIds) stmt.run(conversationId, id);
    });
    tx();
  }

  async unregister(conversationId: number, agentIds?: string[]): Promise<void> {
    if (agentIds && agentIds.length > 0) {
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
  }

  async listRegistered(): Promise<Array<{ conversationId: number; agentIds: string[] }>> {
    const rows = this.db
      .prepare(`SELECT conversation_id as conversationId, agent_id as agentId FROM runner_registry`)
      .all() as Array<{ conversationId: number; agentId: string }>;
    const byConv = new Map<number, string[]>();
    for (const r of rows) {
      if (!byConv.has(r.conversationId)) byConv.set(r.conversationId, []);
      byConv.get(r.conversationId)!.push(r.agentId);
    }
    return Array.from(byConv.entries()).map(([conversationId, agentIds]) => ({ conversationId, agentIds }));
  }
}

