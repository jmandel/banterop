import type { IAgentRegistry } from '$src/control/agent-lifecycle.interfaces';

export class BrowserAgentRegistry implements IAgentRegistry {
  constructor(private storageKey = '__agent_registry__') {}

  private read(): Map<number, string[]> {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(this.storageKey) : null;
    return stored ? new Map(JSON.parse(stored)) : new Map();
  }

  private write(registry: Map<number, string[]>): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(this.storageKey, JSON.stringify(Array.from(registry.entries())));
  }

  async register(conversationId: number, agentIds: string[]): Promise<void> {
    const registry = this.read();
    const existing = registry.get(conversationId) || [];
    const updated = Array.from(new Set([...existing, ...agentIds]));
    registry.set(conversationId, updated);
    this.write(registry);
  }

  async unregister(conversationId: number, agentIds?: string[]): Promise<void> {
    const registry = this.read();
    if (!agentIds || agentIds.length === 0) {
      registry.delete(conversationId);
    } else {
      const existing = registry.get(conversationId) || [];
      const updated = existing.filter((id) => !agentIds.includes(id));
      if (updated.length > 0) registry.set(conversationId, updated);
      else registry.delete(conversationId);
    }
    this.write(registry);
  }

  async listRegistered(): Promise<Array<{ conversationId: number; agentIds: string[] }>> {
    const registry = this.read();
    return Array.from(registry.entries()).map(([conversationId, agentIds]) => ({ conversationId, agentIds }));
  }
}

