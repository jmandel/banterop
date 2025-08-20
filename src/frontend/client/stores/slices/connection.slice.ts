import type { Protocol } from '../../protocols';
import type { AppState } from '../appStore';
import { type Protocol as ProtoType } from '../../protocols';
import { refreshPreview as svcRefreshPreview, detectEffectiveProtocol, createClient } from '../../services/connection.service';
import { AttachmentSummarizer } from '../../attachment-summaries';
import { useConfigStore } from '../configStore';

let autoConnectTimer: any = null;

type Set = (fn: (s: AppState) => void) => void;
type Get = () => AppState;

export function createConnectionSlice(set: Set, get: Get): any {
  return {
    connection: {
      endpoint: '',
      protocol: 'auto' as Protocol,
      status: 'disconnected' as const,
      error: undefined as string | undefined,
      card: undefined as any,
      detectedProtocol: undefined as any,
    },
    actions: {
      scheduleAutoConnect: () => {
        const ep = (get().connection.endpoint || '').trim();
        if (!ep) return;
        if (get().connection.status !== 'disconnected') return;
        clearTimeout(autoConnectTimer);
        autoConnectTimer = setTimeout(async () => {
          try {
            await get().actions.refreshPreview();
            const preview: any = (get().connection as any).preview;
            if (!preview || preview.protocol === 'cannot-detect' || preview.status === 'error') return;
            // Attempt connect using current endpoint/protocol
            await get().actions.connect(get().connection.endpoint, get().connection.protocol);
          } catch { /* ignore */ }
        }, 350);
      },
      refreshPreview: async () => {
        const ep = (get().connection.endpoint || '').trim();
        const proto = get().connection.protocol;
        if (!ep) { set((s) => { s.connection.preview = undefined as any; s.connection.card = undefined; }); return; }
        const effective = detectEffectiveProtocol(ep, proto);
        set((s) => { s.connection.detectedProtocol = effective as any; });
        const preview = await svcRefreshPreview(ep, proto);
        set((s) => {
          (s.connection as any).preview = preview as any;
          if (preview.protocol === 'a2a') s.connection.card = (preview as any).card;
          else if (preview.protocol === 'mcp' && (preview as any).status === 'tools') s.connection.card = { name: 'MCP Endpoint', mcp: { toolNames: (preview as any).tools || [] } } as any;
          else s.connection.card = undefined;
        });
      },
      connect: async (endpoint: string, protocol: Protocol) => {
        const ep = String(endpoint || '').trim();
        if (!ep) {
          await get().actions.disconnect();
          return;
        }
        set((s) => {
          s.connection.endpoint = ep;
          s.connection.protocol = protocol;
          s.connection.status = 'connecting';
          s.connection.error = undefined;
          s.connection.card = undefined;
          (s.connection as any).preview = undefined;
        });
        // Persist to config so reloads keep the latest values
        try { useConfigStore.getState().actions.updateField('endpoint', ep); } catch {}
        try { useConfigStore.getState().actions.updateField('protocol', protocol); } catch {}
        const effective: ProtoType = detectEffectiveProtocol(ep, protocol);
        set((s) => { s.connection.detectedProtocol = effective as any; });
        // Prepare preview first; bail on known errors
        await get().actions.refreshPreview();
        const preview = (get().connection as any).preview as any;
        if (!preview || preview.protocol === 'cannot-detect' || preview.status === 'error') {
          set((s) => { s.connection.status = 'error'; s.connection.error = preview?.error || 'Could not detect or connect'; });
          return;
        }
        // Create client via service. For A2A, prefer agent-card.url as the JSON-RPC base
        let clientBase = ep;
        try {
          if (effective === 'a2a' && preview?.card?.url && typeof preview.card.url === 'string') {
            clientBase = String(preview.card.url);
          }
        } catch {}
        const client = createClient(clientBase, effective as Exclude<ProtoType,'auto'>);
        // Attach listener
        const off = client.on('new-task', () => {
          const task = client.getTask();
          const tid = client.getTaskId();
          const status = client.getStatus();
          set((s) => {
            if (tid) s.task.id = tid;
            if (status) s.task.status = status as any;
            if (task?.history) s.task.history = task.history as any;
          });
          const id = tid || undefined;
          const storage = (get() as any)._storage || null; // no-op; storage handling stays in appStore helpers
          try { if ((storage as any)?.saveSession && ep && id) (storage as any).saveSession(ep, { taskId: id, status: status as any }); } catch {}
        });
        // Save references in store
        set((s) => { s._internal.taskClient = client; s._internal.taskOffs.forEach((fn) => { try { fn(); } catch {} }); s._internal.taskOffs = [off]; });
        // Setup summarizer
        const summarizer = new AttachmentSummarizer(() => get().planner.model || undefined, get()._internal.vault);
        summarizer.onUpdate((_name) => { set((s) => s); });
        set((s) => { s._internal.summarizer = summarizer; });

        set((s) => {
          s.connection.status = 'connected';
          s.task.status = 'initializing';
        });

        // Auto-resume if possible
        try { await get().actions.resumeTask(); } catch {}
      },
      disconnect: async () => {
        const client = get()._internal.taskClient as any;
        try { if (client?.getTaskId()) await client.cancel(); } catch {}
        try { client?.clearLocal?.(); } catch {}
        try { get()._internal.taskOffs.forEach((fn: any) => fn()); } catch {}
        set((s) => { s._internal.taskOffs = []; s._internal.taskClient = null; });
        get().actions.stopPlanner();
        get()._internal.vault.purgeBySource(['agent', 'remote-agent']);
        set((s) => {
          s.connection.status = 'disconnected';
          s.connection.error = undefined;
          s.connection.card = undefined;
          s.task.id = undefined;
          s.task.status = 'initializing';
          s.planner.eventLog = [];
        });
      },
      setEndpoint: (endpoint: string) => {
        set((s) => { s.connection.endpoint = endpoint; });
        // Persist to config storage for durability across reloads
        try { useConfigStore.getState().actions.updateField('endpoint', endpoint); } catch {}
        // If currently connected, disconnect on change
        if (get().connection.status === 'connected') {
          (async () => { try { await get().actions.disconnect(); } catch {} })();
        }
        void get().actions.refreshPreview();
        (get() as any).actions.scheduleAutoConnect?.();
      },
      setProtocol: (protocol: Protocol) => {
        set((s) => { s.connection.protocol = protocol; });
        // Persist to config storage for durability across reloads
        try { useConfigStore.getState().actions.updateField('protocol', protocol); } catch {}
        // If currently connected, disconnect on change
        if (get().connection.status === 'connected') {
          (async () => { try { await get().actions.disconnect(); } catch {} })();
        }
        void get().actions.refreshPreview();
        (get() as any).actions.scheduleAutoConnect?.();
      },
      setCard: (card: any | undefined) => {
        set((s) => { s.connection.card = card; });
      },
      setConnectionStatus: (status: AppState['connection']['status'], error?: string) => {
        set((s) => { s.connection.status = status; s.connection.error = error; });
      },
    },
  } as any;
}
