import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Protocol } from '../protocols';
import type { A2AStatus, A2AMessage, A2APart } from '../a2a-types';
import type { TaskClientLike } from '../protocols/task-client';
import type { UnifiedEvent } from '../types/events';
import { ScenarioPlanner } from '../planner-scenario';
// Store is composed from slices; app imports only useAppStore
import { createConnectionSlice } from './slices/connection.slice';
import { AttachmentVault } from '../attachments-vault';
import { AttachmentSummarizer } from '../attachment-summaries';
import { StorageService } from '../services/StorageService';
import { type Protocol as ProtoType } from '../protocols';
import { refreshPreview as svcRefreshPreview, detectEffectiveProtocol, createClient } from '../services/connection.service';
import { useConfigStore } from './configStore';
import { API_BASE } from '../api-base';
import { BrowsersideLLMProvider } from '$src/llm/providers/browserside';

// Minimal public shape for the app store. This mirrors SessionManager for now.
export interface AppState {
  connection: {
    endpoint: string;
    protocol: Protocol;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    error?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    card?: any;
    detectedProtocol?: Exclude<Protocol, 'auto'>;
    // lightweight preview info for UI hints
    preview?:
      | { protocol: 'cannot-detect' }
      | { protocol: 'mcp'; status: 'connecting' | 'tools' | 'error'; tools?: string[]; error?: string }
      | { protocol: 'a2a'; status: 'connecting' | 'agent-card' | 'error'; error?: string };
  };

  task: {
    id?: string;
    status: A2AStatus | 'initializing';
    history: A2AMessage[];
    client: TaskClientLike | null;
  };

  planner: {
    instance: ScenarioPlanner | null;
    started: boolean;
    thinking: boolean;
    eventLog: UnifiedEvent[];
    instructions: string;
    model: string;
  };

  scenario: {
    url: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: any | null;
    selectedAgents: { planner?: string; counterpart?: string };
    enabledTools: string[];
    error?: string;
    loading?: boolean;
  };

  attachments: {
    summarizeOnUpload: boolean;
  };

  _internal: {
    taskClient: TaskClientLike | null;
    taskOffs: Array<() => void>;
    plannerOff: (() => void) | null;
    vault: AttachmentVault;
    summarizer: AttachmentSummarizer | null;
  };

  // Actions are intentionally thin; business logic stays in domain/services
  actions: {
    // Connection
    connect: (endpoint: string, protocol: Protocol) => Promise<void>;
    resumeTask: (taskId?: string) => Promise<void>;
    disconnect: () => Promise<void>;
    refreshPreview: () => Promise<void>;
    // Optional internal action from connection slice
    scheduleAutoConnect?: () => void;
    setEndpoint: (endpoint: string) => void;
    setProtocol: (protocol: Protocol) => void;
    setCard: (card: any | undefined) => void;
    setConnectionStatus: (status: AppState['connection']['status'], error?: string) => void;

    // Task
    setTaskState: (s: Partial<Pick<AppState['task'], 'id' | 'status' | 'history'>>) => void;
    sendMessage: (parts: A2APart[]) => Promise<void>;
    cancelTask: () => void;
    restartScenario: () => Promise<void>;

    // Planner
    setInstructions: (text: string) => void;
    setModel: (model: string) => void;
    appendPlannerEvent: (ev: UnifiedEvent) => void;
    startPlanner: () => void;
    stopPlanner: () => void;
    setPlannerThinking: (b: boolean) => void;

    // Scenario
    setScenarioUrl: (url: string) => void;
    loadScenario: () => Promise<void>;
    setScenarioConfig: (cfg: any | null) => void;
    selectAgent: (role: 'planner' | 'counterpart', id: string) => void;
    setEnabledTools: (names: string[]) => void;

    // Attachments
    uploadFiles: (files: FileList | null) => Promise<void>;
    analyzeAttachment: (name: string) => void;
    openAttachment: (name: string) => Promise<void>;
    toggleSummarizeOnUpload: (on: boolean) => void;
  };
}

export const useAppStore = create<AppState>()(
  immer((set, get) => {
    const connectionSlice = createConnectionSlice(set as any, get as any) as Partial<AppState>;
    return ({
    ...(connectionSlice as any),
    task: {
      id: undefined,
      status: 'initializing',
      history: [],
      client: null,
    },
    planner: {
      instance: null,
      started: false,
      thinking: false,
      eventLog: [],
      instructions: '',
      model: '',
    },
    scenario: {
      url: '',
      config: null,
      selectedAgents: {},
      enabledTools: [],
      error: undefined,
      loading: false,
    },
    attachments: {
      summarizeOnUpload: new StorageService().loadSummarizeOnUpload(),
    },
    _internal: {
      taskClient: null,
      taskOffs: [],
      plannerOff: null,
      vault: new AttachmentVault(),
      summarizer: null,
    },
    actions: {
      // merge connection actions from slice first
      ...(connectionSlice as any).actions,
      // Remaining domain actions
      resumeTask: async (taskId?: string) => {
        const storage = ensureStorage();
        const ep = get().connection.endpoint;
        const client = get()._internal.taskClient as TaskClientLike | null;
        if (!ep || !client) return;
        let target = String(taskId || '').trim();
        if (!target) {
          const ptr = storage.loadSession(ep);
          if (ptr?.taskId) target = ptr.taskId;
        }
        if (!target) return;
        await client.resume(target);
        set((s) => { s.task.id = target; });
        // Save/refresh the session pointer so a subsequent reload can resume
        try {
          const status = (client as any)?.getStatus?.() || get().task.status;
          storage.saveSession(ep, { taskId: target, status: status as any });
        } catch {}
        // Load per-task state
        const saved = storage.loadTaskSession(ep, target);
        if (saved?.plannerEvents && Array.isArray(saved.plannerEvents) && saved.plannerEvents.length) {
          set((s) => { s.planner.eventLog = saved.plannerEvents as any; });
        }
        if (saved?.plannerStarted) {
          get().actions.startPlanner();
        }
      },
      // Note: disconnect/setEndpoint/setProtocol/etc come from connection slice
      setTaskState: (p) => {
        set((s) => {
          if (p.id !== undefined) s.task.id = p.id;
          if (p.status !== undefined) s.task.status = p.status as any;
          if (p.history !== undefined) s.task.history = p.history as any;
        });
      },
      sendMessage: async (_parts: A2APart[]) => {
        // Simplified: send only text via planner record
        const textPart = (_parts || []).find((p) => p.kind === 'text') as any;
        const text = textPart?.text ? String(textPart.text) : '';
        if (!text.trim()) return;
        if (!get().planner.started) get().actions.startPlanner();
        try { (get().planner.instance as any)?.recordUserReply?.(text); } catch {}
      },
      cancelTask: () => {
        (async () => {
          const ep = get().connection.endpoint;
          const tid = get()._internal.taskClient?.getTaskId();
          try {
            const st = get().task.status;
            const canCancel = st === 'submitted' || st === 'working' || st === 'input-required';
            if (canCancel) {
              await get()._internal.taskClient?.cancel();
            }
          } catch {}
          try { get()._internal.taskClient?.clearLocal(); } catch {}
          try { get()._internal.taskOffs.forEach((fn: any) => fn()); } catch {}
          set((s) => { s._internal.taskOffs = []; s._internal.taskClient = null; });
          get().actions.stopPlanner();
          get()._internal.vault.purgeBySource(['agent', 'remote-agent']);
          if (ep && tid) ensureStorage().removeTaskSession(ep, tid);
          if (ep) ensureStorage().removeSession(ep);
          set((s) => {
            s.task.id = undefined;
            s.task.status = 'initializing';
            s.connection.status = 'disconnected';
            s.connection.card = undefined;
            s.planner.eventLog = [];
          });
        })();
      },
      restartScenario: async () => {
        // Best-effort cancel; proceed regardless of outcome
        try { await get().actions.cancelTask(); } catch {}
        try { await get().actions.refreshPreview(); } catch {}
        try { (get().actions as any).scheduleAutoConnect?.(); } catch {}
      },
      setInstructions: (text: string) => {
        set((s) => { s.planner.instructions = text; });
        try { ensureStorage().savePlannerInstructions(text); } catch {}
        // Keep config runtime + storage in sync so reloads persist edits
        try { useConfigStore.getState().actions.updateField('instructions', text); } catch {}
      },
      setModel: (model: string) => {
        set((s) => { s.planner.model = model; });
        try { ensureStorage().saveSelectedModel(model); } catch {}
        // Persist to config store (used for URL-less reloads)
        try { useConfigStore.getState().actions.updateField('model', model); } catch {}
      },
      appendPlannerEvent: (ev: UnifiedEvent) => {
        set((s) => { s.planner.eventLog.push(ev); });
        // Persist snapshot
        // persistence handled by subscriptions
      },
      startPlanner: () => {
        if (get().planner.instance) return;
        const client = get()._internal.taskClient as TaskClientLike | null;
        if (!client) return;
        // Provide a shared BrowsersideLLMProvider instance to the planner
        const provider = new BrowsersideLLMProvider({ provider: 'browserside', apiBase: API_BASE });
        const planner = new ScenarioPlanner({
          task: client,
          vault: get()._internal.vault,
          // API base not needed when scenario JSON is provided directly
          getApiBase: undefined,
          getEndpoint: () => '',
          getModel: () => get().planner.model,
          getLLMProvider: () => provider,
          getPlannerAgentId: () => get().scenario.selectedAgents.planner,
          getCounterpartAgentId: () => get().scenario.selectedAgents.counterpart,
          getScenarioConfig: () => get().scenario.config,
          getEnabledTools: () => getEnabledToolDefsFromStore(get()),
          getAdditionalInstructions: () => get().planner.instructions,
          onSystem: () => {},
          onAskUser: () => {},
          onPlannerThinking: (b: boolean) => { set((s) => { s.planner.thinking = !!b; }); },
        });
        // preload any existing events in store
        try { (planner as any).loadEvents(get().planner.eventLog as any); } catch {}
        const off = planner.onEvent((ev) => {
          get().actions.appendPlannerEvent(ev);
        });
        set((s) => { s._internal.plannerOff = off; });
        set((s) => { s.planner.instance = planner; s.planner.started = true; });
        planner.start();
      },
      stopPlanner: () => {
        try { (get().planner.instance as any)?.stop?.(); } catch {}
        try { get()._internal.plannerOff?.(); } catch {}
        set((s) => { s._internal.plannerOff = null; });
        set((s) => { s.planner.instance = null; s.planner.started = false; s.planner.thinking = false; });
      },
      setPlannerThinking: (b: boolean) => {
        set((s) => { s.planner.thinking = b; });
      },
      setScenarioUrl: (url: string) => {
        set((s) => {
          s.scenario.url = url;
          s.scenario.error = undefined;
          // Clear prior scenario state so UI reflects current URL, not stale config
          s.scenario.config = null;
          s.scenario.selectedAgents = {};
          s.scenario.enabledTools = [];
        });
      },
      loadScenario: async () => {
        const u = (get().scenario.url || '').trim();
        if (!u) {
          set((s) => {
            s.scenario.config = null;
            s.scenario.error = undefined;
            s.scenario.selectedAgents = {};
            s.scenario.enabledTools = [];
          });
          return;
        }
        set((s) => { s.scenario.loading = true; s.scenario.error = undefined; });
        try {
          const res = await fetch(u, { cache: 'no-cache', headers: { 'Cache-Control': 'no-cache' } });
          if (!res.ok) throw new Error(`Scenario fetch failed: ${res.status}`);
          const j = await res.json();
          const cfg = (j?.config ?? j) as any;
          set((s) => { s.scenario.config = cfg; });
          // restore selection
          const agents: string[] = Array.isArray(cfg?.agents) ? (cfg.agents as any[]).map((a) => String(a?.agentId || '')).filter(Boolean) : [];
          const saved = ensureStorage().loadScenarioSelection(u) || {};
          let planner = saved.planner && agents.includes(saved.planner) ? saved.planner : undefined;
          let counterpart = saved.counterpart && agents.includes(saved.counterpart) ? saved.counterpart : undefined;
          if (!planner && agents.length) planner = agents[0];
          if (!counterpart && agents.length > 1) counterpart = agents.find((a) => a !== planner) || agents[1];
          set((s) => { s.scenario.selectedAgents = { planner, counterpart }; });
          ensureStorage().saveScenarioSelection(u, get().scenario.selectedAgents);
          // restore tools for planner
          if (planner) {
            const allTools: string[] = Array.isArray(cfg?.agents?.find((a: any) => a?.agentId === planner)?.tools)
              ? (cfg?.agents?.find((a: any) => a?.agentId === planner)?.tools || []).map((t: any) => String(t?.toolName || t?.name || '')).filter(Boolean)
              : [];
            const savedTools = ensureStorage().loadScenarioTools(u, planner);
            const next = (savedTools || allTools).filter((n) => allTools.includes(n));
            set((s) => { s.scenario.enabledTools = next; });
          } else {
            set((s) => { s.scenario.enabledTools = []; });
          }
          set((s) => { s.scenario.error = undefined; });
        } catch (e: any) {
          set((s) => { s.scenario.error = String(e?.message ?? e); });
        } finally {
          set((s) => { s.scenario.loading = false; });
        }
      },
      setScenarioConfig: (cfg: any | null) => {
        set((s) => { s.scenario.config = cfg; });
      },
      selectAgent: (role, id) => {
        set((s) => {
          if (role === 'planner') s.scenario.selectedAgents.planner = id;
          if (role === 'counterpart') s.scenario.selectedAgents.counterpart = id;
        });
        const url = (get().scenario.url || '').trim();
        if (url) ensureStorage().saveScenarioSelection(url, get().scenario.selectedAgents);
        // update enabled tools default or restore
        try {
          if (role === 'planner') {
            const cfg: any = get().scenario.config;
            const planner = id;
            const agentDef = Array.isArray(cfg?.agents) ? cfg.agents.find((a: any) => a?.agentId === planner) : null;
            const allTools: string[] = Array.isArray(agentDef?.tools)
              ? agentDef.tools.map((t: any) => String(t?.toolName || t?.name || '')).filter(Boolean)
              : [];
            const saved = url ? ensureStorage().loadScenarioTools(url, planner) : null;
            const next = (saved || allTools).filter((n) => allTools.includes(n));
            set((s) => { s.scenario.enabledTools = next; });
          }
        } catch {}
      },
      setEnabledTools: (names: string[]) => {
        const url = (get().scenario.url || '').trim();
        const planner = get().scenario.selectedAgents.planner;
        const unique = Array.from(new Set((names || []).filter(Boolean)));
        set((s) => { s.scenario.enabledTools = unique; });
        if (url && planner) ensureStorage().saveScenarioTools(url, planner, unique);
      },
      // Attachments
      uploadFiles: async (files: FileList | null) => {
        if (!files) return;
        const vault = get()._internal.vault;
        for (const file of Array.from(files)) {
          const rec = await vault.addFile(file);
          if (get().attachments.summarizeOnUpload) get()._internal.summarizer?.queueAnalyze(rec.name, { priority: rec.priority || false });
        }
        set((s) => s);
      },
      analyzeAttachment: (name: string) => {
        get()._internal.summarizer?.queueAnalyze(name, { priority: true });
      },
      openAttachment: async (name: string) => {
        try {
          const rec = get()._internal.vault.getByName(name);
          if (!rec) return;
          const mimeType = String(rec?.mimeType || 'application/octet-stream');
          const bytes = String(rec?.bytes || '');
          if (bytes) {
            let safeMime = mimeType || 'application/octet-stream';
            if (/^text\//i.test(safeMime) && !/charset=/i.test(safeMime)) safeMime = `${safeMime}; charset=utf-8`;
            const bin = atob(bytes);
            const len = bin.length;
            const buf = new Uint8Array(len);
            for (let i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
            const blob = new Blob([buf], { type: safeMime });
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }
        } catch {}
      },
      toggleSummarizeOnUpload: (on: boolean) => {
        const v = !!on;
        try { ensureStorage().saveSummarizeOnUpload(v); } catch {}
        set((s) => { s.attachments.summarizeOnUpload = v; });
      },
    },
  });
  })
);

// Simple derived selectors
export const selectCanSendMessage = (state: AppState) => {
  return state.connection.status === 'connected' &&
    state.task.status === 'input-required' &&
    state.planner.started &&
    !state.planner.thinking;
};

// Internal helpers held in module closure
let _storage: StorageService | null = null;
function ensureStorage() { if (!_storage) _storage = new StorageService(); return _storage; }

function getEnabledToolDefsFromStore(s: AppState): Array<{ name: string; description?: string }> {
  try {
    const cfg = s.scenario.config as any;
    const plannerId = s.scenario.selectedAgents.planner;
    const agent = Array.isArray(cfg?.agents) ? cfg.agents.find((a: any) => a?.agentId === plannerId) : null;
    const all: Array<{ name: string; description?: string }> = Array.isArray(agent?.tools)
      ? agent.tools.map((t: any) => ({ name: String(t?.toolName || t?.name || ''), description: t?.description ? String(t.description) : undefined })).filter((t: any) => t.name)
      : [];
    const enabledSet = new Set(s.scenario.enabledTools);
    return all.filter((t) => enabledSet.has(t.name));
  } catch { return []; }
}

// Expose read-only access to the attachment vault for UI components
export function getAttachmentVaultForUI() {
  return useAppStore.getState()._internal.vault;
}
