import type { OrchestratorControl } from './orchestrator-control';

export class WsControl implements OrchestratorControl {
  constructor(private url: string) {}

  private call<T>(method: string, params?: any): Promise<T> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const id = crypto.randomUUID();

      ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data));
          if (msg.id !== id) return;
          ws.close();
          if (msg.error) {
            reject(new Error(msg.error.message || 'RPC error'));
          } else {
            resolve(msg.result as T);
          }
        } catch (err) {
          ws.close();
          reject(err);
        }
      };
      ws.onerror = (err) => {
        try { ws.close(); } catch {}
        reject(err);
      };
    });
  }

  async createConversation(meta: any) { 
    const res = await this.call<{ conversationId: number }>('createConversation', { meta });
    return res.conversationId;
  }

  getConversation(conversationId: number, opts?: { includeScenario?: boolean }) {
    return this.call<import('$src/types/orchestrator.types').ConversationSnapshot>('getConversation', { conversationId, includeScenario: !!opts?.includeScenario });
  }

  async lifecycleGetEnsured(conversationId: number) {
    return this.call<{ ensured: Array<{ id: string; class?: string }> }>('lifecycle.getEnsured', { conversationId });
  }

  async lifecycleEnsure(conversationId: number, agentIds?: string[]) {
    return this.call<{ ensured: Array<{ id: string; class?: string }> }>('lifecycle.ensure', { conversationId, agentIds });
  }

  async lifecycleStop(conversationId: number, agentIds?: string[]) { 
    await this.call('lifecycle.stop', { conversationId, agentIds });
  }

  
}
