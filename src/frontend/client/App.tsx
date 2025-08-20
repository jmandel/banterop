import React, { useEffect, useReducer, useRef, useState } from "react";
import { AppLayout } from "../ui";
import { A2AClient } from "./a2a-client";
import type { A2AStatus } from "./a2a-types";
import { AttachmentVault } from "./attachments-vault";
import { AttachmentSummarizer } from "./attachment-summaries";
import { DualConversationView } from "./components/Conversations/DualConversationView";
import type { UnifiedEvent as PlannerUnifiedEvent } from "./types/events";
import { selectFrontMessages, selectAgentLog, selectLastStatus } from "./selectors/transcripts";
import { EventLogView } from "./components/EventLogView";
import { StepFlow } from "./components/StepFlow/StepFlow";
import { ScenarioPlannerV2 } from "./planner-scenario";
import { API_BASE } from './api-base';
import { listMcpTools } from './protocols/mcp-utils';
import { createTaskClient, detectProtocolFromUrl, type Protocol } from "./protocols";
import type { TaskClientLike } from "./protocols/task-client";
import { useDebounce } from "./useDebounce";

type PlannerMode = "passthrough" | "autostart" | "approval";

type Model = {
  connected: boolean;
  endpoint: string;
  protocol: Protocol;
  taskId?: string;
  status: A2AStatus | "initializing";
  plannerMode: PlannerMode;
  plannerStarted: boolean;
  busy: boolean;
  error?: string;
  summarizeOnUpload: boolean;
};

type Act =
  | { type: "connect"; endpoint: string; protocol: Protocol }
  | { type: "setTask"; taskId?: string }
  | { type: "status"; status: A2AStatus | "initializing" }
  | { type: "busy"; busy: boolean }
  | { type: "error"; error?: string }
  | { type: "setPlannerMode"; mode: PlannerMode }
  | { type: "setPlannerStarted"; started: boolean }
  | { type: "toggleSummarizeOnUpload"; on: boolean }
  | { type: "clearConversation" }
  | { type: "reset" };

const initModel = (endpoint: string, protocol: Protocol): Model => ({
  connected: false,
  endpoint,
  protocol,
  status: "initializing",
  plannerMode: (localStorage.getItem("a2a.planner.mode") as PlannerMode) || "autostart",
  plannerStarted: false,
  busy: false,
  summarizeOnUpload: localStorage.getItem("a2a.planner.summarizeOnUpload") !== "false",
});

function reducer(m: Model, a: Act): Model {
  switch (a.type) {
    case "connect":
      return { ...m, connected: true, endpoint: a.endpoint, protocol: a.protocol, error: undefined };
    case "setTask":
      return { ...m, taskId: a.taskId };
    case "status":
      return { ...m, status: a.status };
    case "busy":
      return { ...m, busy: a.busy };
    case "error":
      return { ...m, error: a.error };
    case "setPlannerMode":
      return { ...m, plannerMode: a.mode };
    case "setPlannerStarted":
      return { ...m, plannerStarted: a.started };
    case "toggleSummarizeOnUpload":
      return { ...m, summarizeOnUpload: a.on };
    case "clearConversation":
      return {
        ...m,
        taskId: undefined,
        status: "initializing",
        plannerStarted: false,
        busy: false,
        error: undefined,
      };
    case "reset":
      return { ...initModel(m.endpoint, m.protocol) };
    default:
      return m;
  }
}

// Optional free-form guidance to augment scenario prompt

export default function App() {
  // Safe UTF-8 → base64url (sync) for localStorage keys
  const toBase64Url = (s: string) => {
    try {
      const bytes = new TextEncoder().encode(s ?? '');
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const b64 = btoa(bin);
      return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch { return s; }
  };
  // Parse prefill params from URL (hash or search)
  const parsePrefillParams = () => {
    try {
      const href = (typeof window !== 'undefined' ? window.location.href : '') || '';
      const u = new URL(href);
      const hash = (u.hash || '').replace(/^#\/?/, '');
      // Prefer hash query string (/#/?...)
      const q = hash.includes('?') ? hash.substring(hash.indexOf('?')) : u.search;
      const sp = new URLSearchParams(q);
      return {
        protocol: (sp.get('protocol') || '').toLowerCase(),
        endpoint: sp.get('endpoint') || '',
        scenarioUrl: sp.get('scenarioUrl') || '',
        plannerAgentId: sp.get('plannerAgentId') || '',
        counterpartAgentId: sp.get('counterpartAgentId') || '',
        defaultModel: sp.get('defaultModel') || ''
      };
    } catch {
      return { protocol: '', endpoint: '', scenarioUrl: '', plannerAgentId: '', counterpartAgentId: '', defaultModel: '' };
    }
  };
  const prefill = parsePrefillParams();
  const initialEndpoint = prefill.endpoint || localStorage.getItem("a2a.endpoint") || "";
  const initialProto: Protocol = (() => {
    const ep = (initialEndpoint || '').trim();
    const detected = detectProtocolFromUrl(ep);
    // If endpoint declares a protocol, prefer Auto so detection drives requests
    if (detected) return 'auto';
    // With no endpoint, default to Auto
    if (!ep) return 'auto';
    // Otherwise honor persisted user selection; ignore any URL prefill
    const persisted = (localStorage.getItem('a2a.protocol') as Protocol) || 'auto';
    return (persisted === 'a2a' || persisted === 'mcp' || persisted === 'auto') ? persisted : 'auto';
  })();
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [protocol, setProtocol] = useState<Protocol>(initialProto);
  const debouncedEndpoint = useDebounce(endpoint, 500);
  const [resumeTask, setResumeTask] = useState("");
  const [instructions, setInstructions] = useState(
    () => localStorage.getItem("a2a.planner.instructions") || ""
  );
  // Additional planner instructions (optional)
  // Deprecated: goals/background not used; kept for compatibility
  const [goals, setGoals] = useState<string>("");
  const [providers, setProviders] = useState<Array<{ name: string; models: string[] }>>([]);
  const [plannerThinking, setPlannerThinking] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(() => prefill.defaultModel || localStorage.getItem("a2a.planner.model") || "");

  const [model, dispatch] = useReducer(reducer, initModel(initialEndpoint, initialProto));

  const clientRef = useRef<A2AClient | null>(null);
  const vaultRef = useRef(new AttachmentVault());
  // const providerRef = useRef<ServerLLMProvider | null>(null);
  const taskRef = useRef<TaskClientLike | null>(null);
  // const plannerRef = useRef<Planner | null>(null);
  const scenarioPlannerRef = useRef<ScenarioPlannerV2 | null>(null);
  const scenarioPlannerOffRef = useRef<(() => void) | null>(null);
  const summarizerRef = useRef<AttachmentSummarizer | null>(null);
  const selectedModelRef = useRef<string>(selectedModel);
  const plannerModeRef = useRef<PlannerMode>("autostart");
  const plannerStartedRef = useRef<boolean>(false);
  // no-op placeholders removed; unified event log drives UI
  // Scenario URL + agent selection
  const [scenarioUrl, setScenarioUrl] = useState<string>(() => prefill.scenarioUrl || localStorage.getItem("a2a.scenario.url") || "");

  // When the user edits Endpoint or Scenario URL, scrub those params from the URL so reloads don't override
  const clearHashParams = (keys: string[]) => {
    try {
      if (typeof window === 'undefined') return;
      const u = new URL(window.location.href);
      const hash = u.hash || '';
      let prefix = hash && hash.includes('?') ? hash.slice(0, hash.indexOf('?')) : (hash || '#/');
      const qs = hash && hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : (u.search ? u.search.slice(1) : '');
      const sp = new URLSearchParams(qs);
      keys.forEach(k => sp.delete(k));
      const newHash = prefix + (sp.toString() ? `?${sp.toString()}` : '');
      const newUrl = `${u.origin}${u.pathname}${newHash}`;
      if (newUrl !== window.location.href) {
        history.replaceState(null, '', newUrl);
      }
    } catch {}
  };

  const handleEndpointChange = (v: string) => {
    setEndpoint(v);
    clearHashParams(['endpoint','protocol','defaultModel']);
  };
  const handleScenarioUrlChange = (v: string) => {
    setScenarioUrl(v);
    clearHashParams(['scenarioUrl','protocol','defaultModel']);
  };
  const debouncedScenarioUrl = useDebounce(scenarioUrl, 500);
  const [scenarioAgents, setScenarioAgents] = useState<string[]>([]);
  const [scenarioConfig, setScenarioConfig] = useState<any | null>(null);
  const [selectedPlannerAgentId, setSelectedPlannerAgentId] = useState<string | undefined>(undefined);
  const [selectedCounterpartAgentId, setSelectedCounterpartAgentId] = useState<string | undefined>(undefined);
  const [enabledTools, setEnabledTools] = useState<string[]>([]);
  const [card, setCard] = useState<any | null>(null);
  const [cardLoading, setCardLoading] = useState(false);
  const [eventLog, setEventLog] = useState<PlannerUnifiedEvent[]>([]);
  const preloadedEventsRef = useRef<PlannerUnifiedEvent[] | null>(null);
  const eventLogRef = useRef<PlannerUnifiedEvent[]>([]);
  useEffect(() => { eventLogRef.current = eventLog; }, [eventLog]);
  // Derive transcripts and status from unified Event Log
  const derivedFront = React.useMemo(() => selectFrontMessages(eventLog as any), [eventLog]);
  const derivedAgent = React.useMemo(() => selectAgentLog(eventLog as any), [eventLog]);
  const lastStatusStr = React.useMemo(() => selectLastStatus(eventLog as any), [eventLog]);
  const yourTurn = lastStatusStr ? lastStatusStr === 'input-required' : true; // allow initial send pre-status

  // Persist event log whenever it changes (scoped by endpoint + taskId)
  useEffect(() => {
    try {
      const tid = taskRef.current?.getTaskId();
      const ep = (endpoint || '').trim();
      if (!ep || !tid) return;
      const st = lastStatusRef.current;
      saveTaskSession(ep, tid, {
        taskId: tid,
        status: st,
        plannerStarted: plannerStartedRef.current,
        frontDraft: frontInput,
        plannerEvents: (eventLog as any) || [],
      });
      saveSession(ep, { taskId: tid, status: st });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventLog]);

  // Event queue with monotonic counter to avoid missed wakeups
  const eventCounterRef = useRef(0);
  const waitersRef = useRef<Array<{ target: number; resolve: () => void }>>([]);
  const signalEvent = (source?: string) => {
    eventCounterRef.current++;
    const cur = eventCounterRef.current;
    try { console.debug(`[PlannerWake] signal -> #${cur}${source ? ` from ${source}` : ''}`); } catch {}
    const ready = waitersRef.current.filter(w => w.target <= cur);
    const pending = waitersRef.current.filter(w => w.target > cur);
    waitersRef.current = pending;
    for (const w of ready) {
      try { w.resolve(); } catch {}
    }
  };
  const waitNextEventFn = () => new Promise<void>((resolve) => {
    const target = eventCounterRef.current + 1;
    try { console.debug(`[PlannerWake] wait -> #${target} (current #${eventCounterRef.current})`); } catch {}
    waitersRef.current.push({ target, resolve: () => { try { console.debug(`[PlannerWake] resume <- #${target}`); } catch {} resolve(); } });
  });
  
  const ptSendInFlight = useRef(false);
  const ptStreamAbort = useRef<AbortController | null>(null);
  const lastStatusRef = useRef<A2AStatus | "initializing">("initializing");
  const lastTaskIdRef = useRef<string | undefined>(undefined);

  // Front-stage composer
  const [frontInput, setFrontInput] = useState("");
  const [attachmentUpdateTrigger, setAttachmentUpdateTrigger] = useState(0);
  // Persist front state as user types while task is active
  useEffect(() => {
    const tid = taskRef.current?.getTaskId();
    const st = lastStatusRef.current;
    if (endpoint && tid && st && !['completed','failed','canceled'].includes(String(st))) {
      // Keep minimal endpoint pointer for resume
      saveSession(endpoint, { taskId: tid, status: st });
      // Persist full per-task UI + event state
      try {
        saveTaskSession(endpoint, tid, {
          taskId: tid,
          status: st,
          plannerStarted: plannerStartedRef.current,
          frontDraft: frontInput,
          plannerEvents: (eventLog as any) || [],
        });
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontInput]);

  useEffect(() => {
    localStorage.setItem("a2a.endpoint", endpoint);
  }, [endpoint]);
  useEffect(() => { try { localStorage.setItem("a2a.protocol", protocol); } catch {} }, [protocol]);

  // If endpoint is cleared, reset protocol selector to Auto to avoid misleading MCP/A2A state
  useEffect(() => {
    const ep = (endpoint || '').trim();
    if (!ep && protocol !== 'auto') setProtocol('auto');
  }, [endpoint]);

  // On initial load, if endpoint includes explicit /a2a or /mcp but UI isn't Auto,
  // force selector to Auto to avoid mismatched requests. Honor explicit prefill.
  const didInitRef = useRef(false);
  const hasPrefillProtocol = prefill.protocol === 'a2a' || prefill.protocol === 'mcp';
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    if (hasPrefillProtocol) return;
    const ep = (initialEndpoint || '').trim();
    if (!ep) return;
    const detected = detectProtocolFromUrl(ep);
    if (detected && protocol !== 'auto') setProtocol('auto');
  }, []);

  useEffect(() => { try { localStorage.setItem("a2a.planner.instructions", instructions); } catch {} }, [instructions]);
  // No longer persisting background/goals by default
  useEffect(() => { try { localStorage.setItem("a2a.planner.model", selectedModel); } catch {} }, [selectedModel]);
  
  // Sync planner settings to localStorage
  useEffect(() => { try { localStorage.setItem("a2a.planner.mode", model.plannerMode); } catch {} }, [model.plannerMode]);
  useEffect(() => { plannerModeRef.current = model.plannerMode; }, [model.plannerMode]);
  useEffect(() => { plannerStartedRef.current = model.plannerStarted; }, [model.plannerStarted]);
  useEffect(() => { try { localStorage.setItem("a2a.planner.summarizeOnUpload", String(model.summarizeOnUpload)); } catch {} }, [model.summarizeOnUpload]);
  useEffect(() => { try { localStorage.setItem("a2a.scenario.url", scenarioUrl); } catch {} }, [scenarioUrl]);

  // Persist planner event log on page unload to avoid losing history on reload
  useEffect(() => {
    const handler = () => {
      try {
        const tid = taskRef.current?.getTaskId();
        if (endpoint && tid) {
          const st = lastStatusRef.current;
          saveTaskSession(endpoint, tid, {
            taskId: tid,
            status: st,
            plannerStarted: plannerStartedRef.current,
            frontDraft: frontInput,
            plannerEvents: (eventLogRef.current as any) || [],
          });
          saveSession(endpoint, { taskId: tid, status: st });
        }
      } catch {}
    };
    window.addEventListener('beforeunload', handler);
    return () => { window.removeEventListener('beforeunload', handler); };
  }, [endpoint, frontInput]);

  // Helper: per-URL key builders
  const scenarioKey = (url: string) => `a2a.scenario.sel.${toBase64Url(url)}`;
  const scenarioToolsKey = (url: string, agentId?: string) => `a2a.scenario.tools.${toBase64Url(url)}${agentId ? `::${agentId}` : ''}`;

  // Restore saved agent selection for this scenario when agent list loads
  useEffect(() => {
    const url = scenarioUrl.trim();
    if (!url || !scenarioAgents.length) return;
    try {
      const raw = localStorage.getItem(scenarioKey(url));
      if (!raw) return;
      const stored = JSON.parse(raw);
      const planner: string | undefined = stored?.planner && scenarioAgents.includes(stored.planner) ? stored.planner : undefined;
      const counterpart: string | undefined = stored?.counterpart && scenarioAgents.includes(stored.counterpart) ? stored.counterpart : undefined;
      if (planner) setSelectedPlannerAgentId(planner);
      if (counterpart) setSelectedCounterpartAgentId(counterpart);
      // Restore enabled tools for this scenario URL + agent if present
      if (planner) {
        const toolsRaw = localStorage.getItem(scenarioToolsKey(url, planner));
        if (toolsRaw) {
          try {
            const names: string[] = JSON.parse(toolsRaw);
            if (Array.isArray(names)) setEnabledTools(names.filter(Boolean));
          } catch {}
        }
      }
    } catch {}
  }, [scenarioAgents, scenarioUrl]);

  // Per-endpoint session persistence for resuming open tasks
  type SessionState = {
    taskId?: string;
    status?: A2AStatus | "initializing";
    plannerStarted?: boolean;
    frontDraft?: string;
    plannerEvents?: PlannerUnifiedEvent[];
  };
  const sessionKey = (ep: string) => `a2a.session.${toBase64Url(ep || '')}`;
  const saveSession = (ep: string, state: SessionState) => {
    try { localStorage.setItem(sessionKey(ep), JSON.stringify(state)); } catch {}
  };
  const removeSession = (ep: string) => {
    try { localStorage.removeItem(sessionKey(ep)); } catch {}
  };
  const loadSession = (ep: string): SessionState | null => {
    try {
      const raw = localStorage.getItem(sessionKey(ep));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      return obj as SessionState;
    } catch { return null; }
  };
  // Per-task scoped session helpers (endpoint + task)
  const taskSessionKey = (ep: string, tid: string) => `a2a.session.${toBase64Url(ep || '')}.task.${toBase64Url(tid)}`;
  const saveTaskSession = (ep: string, tid: string, state: SessionState) => {
    try { localStorage.setItem(taskSessionKey(ep, tid), JSON.stringify(state)); } catch {}
  };
  const loadTaskSession = (ep: string, tid: string): SessionState | null => {
    try {
      const raw = localStorage.getItem(taskSessionKey(ep, tid));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      return obj as SessionState;
    } catch { return null; }
  };
  const removeTaskSession = (ep: string, tid: string) => {
    try { localStorage.removeItem(taskSessionKey(ep, tid)); } catch {}
  };

  // Auto-connect when debounced endpoint or protocol changes
  useEffect(() => {
    if (debouncedEndpoint !== model.endpoint || !model.connected || protocol !== model.protocol) {
      console.log("[App] Auto-connecting to:", debouncedEndpoint, 'protocol=', protocol);
      handleConnect(debouncedEndpoint, protocol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedEndpoint, protocol]);

  // Removed auto-detect protocol effect to avoid race conditions; resolution happens in handleConnect

  // Load provider list
  useEffect(() => {
    (async () => {
      try {
        const base = API_BASE;
        const res = await fetch(`${base}/llm/providers`);
        if (!res.ok) return;
        const list = await res.json();
        const filtered = (Array.isArray(list) ? list : []).filter((p: any) => 
          p?.name !== "browserside" && 
          p?.name !== "mock" &&
          p?.available !== false
        );
        setProviders(filtered);
        if (!selectedModel) {
          const first = filtered.flatMap((p: any) => p.models || [])[0];
          if (first) setSelectedModel(first);
        }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep planner model ref in sync (used by summarizer as well)
  useEffect(() => { selectedModelRef.current = selectedModel; }, [selectedModel]);

  // Apply prefilled agent selections once agents are known, without clobbering saved tool choices
  useEffect(() => {
    if (!scenarioAgents.length) return;
    let planner = selectedPlannerAgentId;
    let counterpart = selectedCounterpartAgentId;
    if (prefill.plannerAgentId && scenarioAgents.includes(prefill.plannerAgentId)) {
      planner = prefill.plannerAgentId;
    }
    if (prefill.counterpartAgentId && scenarioAgents.includes(prefill.counterpartAgentId)) {
      counterpart = prefill.counterpartAgentId;
    }
    if (!planner) planner = scenarioAgents[0];
    if (!counterpart && scenarioAgents.length >= 2) counterpart = scenarioAgents.find(a => a !== planner) || scenarioAgents[1];
    if (planner && planner !== selectedPlannerAgentId) setSelectedPlannerAgentId(planner);
    if (counterpart && counterpart !== selectedCounterpartAgentId) setSelectedCounterpartAgentId(counterpart);
    // Initialize enabled tools for preselected planner ONLY if no saved selection exists
    try {
      const cfg = scenarioConfig as any;
      const agent = cfg?.agents?.find((a: any) => a?.agentId === planner);
      const tools: string[] = Array.isArray(agent?.tools)
        ? agent.tools.map((t: any) => String(t?.toolName || t?.name || '')).filter(Boolean)
        : [];
      const url = scenarioUrl.trim();
      let hasSaved = false;
      if (url && planner) {
        try {
          const savedRaw = localStorage.getItem(scenarioToolsKey(url, planner));
          hasSaved = !!savedRaw;
        } catch {}
      }
      if (!hasSaved && enabledTools.length === 0) {
        setEnabledTools(tools);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioAgents, enabledTools.length]);

  const handleConnect = async (endpointUrl: string, proto: Protocol) => {
    // Cancel any ongoing tasks when endpoint changes
    if (taskRef.current?.getTaskId()) {
      try {
        await cancelTask();
      } catch {}
    }
    
    if (!endpointUrl.trim()) {
      dispatch({ type: "reset" });
      lastStatusRef.current = "submitted";
      lastTaskIdRef.current = undefined;
      clientRef.current = null;
      taskRef.current = null;
      try { scenarioPlannerRef.current?.stop(); } catch {}
      scenarioPlannerRef.current = null;
      return;
    }
    
    dispatch({ type: "reset" });
    lastStatusRef.current = "submitted";
    lastTaskIdRef.current = undefined;
    // Resolve effective protocol when in 'auto' mode (avoid MCP calls against A2A endpoints)
    const selectedProto: Protocol = ((): Protocol => {
      if (proto !== 'auto') return proto;
      const detected = detectProtocolFromUrl(endpointUrl);
      return (detected || 'a2a') as Protocol;
    })();
    dispatch({ type: "connect", endpoint: endpointUrl, protocol: selectedProto });

    clientRef.current = new A2AClient(endpointUrl);
    const taskClient = createTaskClient(selectedProto, endpointUrl);
    taskRef.current = taskClient;

    // Attachment summarizer (background)
    summarizerRef.current = new AttachmentSummarizer(() => selectedModelRef.current || undefined, vaultRef.current);
    summarizerRef.current.onUpdate((_name) => {
      // Update attachment UI when summaries arrive; do not trigger planner ticks
      setAttachmentUpdateTrigger(prev => prev + 1);
    });

    const updateAgentLogFromTask = () => { /* unified log drives UI; no-op */ };
    taskClient.on('new-task', () => {
      const curTask = taskRef.current?.getTaskId();
      if (lastTaskIdRef.current !== curTask) {
        lastTaskIdRef.current = curTask;
        dispatch({ type: "setTask", taskId: curTask });
      }
      signalEvent('store');
    });
    taskClient.on('new-task', () => {
      const st = taskRef.current?.getStatus();
      if (st && lastStatusRef.current !== st) {
        lastStatusRef.current = st;
        dispatch({ type: 'status', status: st });
        // Persist per-task session on status changes
        try {
          const tid = taskRef.current?.getTaskId();
          if (endpointUrl && tid) {
            saveSession(endpointUrl, { taskId: tid, status: st });
            saveTaskSession(endpointUrl, tid, {
              taskId: tid,
              status: st,
              plannerStarted: plannerStartedRef.current,
              frontDraft: frontInput,
              plannerEvents: (eventLog as any) || [],
            });
          }
        } catch {}
      }
    });

    // Fetch agent info: A2A uses agent-card; MCP lists tools
    if (selectedProto === 'a2a') {
      (async () => {
        setCardLoading(true);
        try {
        const base = endpointUrl.replace(/\/+$/, "");
        const res = await fetch(`${base}/.well-known/agent-card.json`);
          if (!res.ok) throw new Error(`Agent card fetch failed: ${res.status}`);
          setCard(await res.json());
        } catch (e: any) {
          setCard({ error: String(e?.message ?? e) });
        } finally {
          setCardLoading(false);
        }
      })();
    } else if (selectedProto === 'mcp') {
      (async () => {
        setCardLoading(true);
        try {
          const names = await listMcpTools(endpointUrl);
          const required = ['begin_chat_thread','send_message_to_chat_thread','check_replies'];
          const missing = required.filter(n => !names.includes(n));
          setCard({ name: 'MCP Endpoint', mcp: { toolNames: names, required, missing } });
        } catch (e: any) {
          setCard({ error: String(e?.message ?? e) });
        } finally {
          setCardLoading(false);
        }
      })();
    }

    // Resume task if provided or stored in session
    let targetTask = resumeTask.trim();
    let savedSess: SessionState | null = null;
    try { savedSess = loadSession(endpointUrl); } catch {}
    // Always pick up the last known task for this endpoint (even if completed) so UI state restores
    if (!targetTask && savedSess?.taskId) {
      targetTask = savedSess.taskId;
    }

    if (targetTask) {
      // Preload any persisted per-task UI before resuming
      try {
        const preSess = loadTaskSession(endpointUrl, targetTask);
        if (preSess) {
          if (typeof preSess.frontDraft === 'string') setFrontInput(preSess.frontDraft);
          const savedEvents = Array.isArray(preSess.plannerEvents) ? (preSess.plannerEvents as any) : [];
          if (savedEvents.length) {
            setEventLog(savedEvents);
            preloadedEventsRef.current = savedEvents as any;
          }
        }
      } catch {}
      try {
        await taskClient.resume(targetTask);
        dispatch({ type: "setTask", taskId: targetTask });
        const taskSess = loadTaskSession(endpointUrl, targetTask);
        if (taskSess?.plannerStarted) {
          // Defer to allow initial snapshot to land
          setTimeout(() => { try { startPlanner(taskSess?.plannerEvents || []); } catch {} }, 0);
        } else {
          // If the thread is in a state where the agent can act, kick the planner to continue
          try {
            const st = taskRef.current?.getStatus();
            if (st === 'working' || st === 'input-required' || st === 'initializing') {
              setTimeout(() => { try { startPlanner(preloadedEventsRef.current || taskSess?.plannerEvents || []); } catch {} }, 0);
            }
          } catch {}
        }
      } catch (e: any) {
        dispatch({ type: "error", error: String(e?.message ?? e) });
      }
    }
  };

  const startPlanner = (preloadedEvents?: PlannerUnifiedEvent[]) => {
    if (scenarioPlannerRef.current) return;
    const task = taskRef.current!;
    const getApiBase = () => API_BASE;
    const orch = new ScenarioPlannerV2({
      task,
      vault: vaultRef.current,
      getApiBase,
      getEndpoint: () => endpoint,
      getModel: () => selectedModel,
      getPlannerAgentId: () => selectedPlannerAgentId,
      getCounterpartAgentId: () => selectedCounterpartAgentId,
      getScenarioConfig: () => scenarioConfig,
      getEnabledTools: () => (currentTools.filter((t: { name: string; description?: string }) => enabledTools.includes(t.name))),
      getAdditionalInstructions: () => instructions,
      onSystem: (_text) => {},
      onAskUser: (_q) => {},
      onPlannerThinking: (b) => setPlannerThinking(b),
    });
    scenarioPlannerRef.current = orch;
    const preload = (preloadedEvents && preloadedEvents.length)
      ? preloadedEvents
      : (preloadedEventsRef.current && preloadedEventsRef.current.length ? preloadedEventsRef.current : []);
    if (preload && preload.length) {
      try { (orch as any).loadEvents(preload as any); } catch {}
    }
    preloadedEventsRef.current = null;
    setEventLog(orch.getEvents() as any);
    const off = orch.onEvent((ev) => {
      setEventLog((prev) => {
        const next = [...prev, ev as any];
        try {
          const tid = taskRef.current?.getTaskId();
          if (endpoint && tid) {
            saveSession(endpoint, { taskId: tid, status: lastStatusRef.current });
            saveTaskSession(endpoint, tid, {
              taskId: tid,
              status: lastStatusRef.current,
              plannerStarted: true,
              frontDraft: frontInput,
              plannerEvents: next as any,
            });
          }
        } catch {}
        return next;
      });
    });
    scenarioPlannerOffRef.current = off;
    orch.start();
    signalEvent('planner-start');
    dispatch({ type: "setPlannerStarted", started: true });
    // Persist per-task session snapshot
    try {
      const tid = taskRef.current?.getTaskId();
      if (endpoint && tid) {
        saveSession(endpoint, { taskId: tid, status: lastStatusRef.current });
        saveTaskSession(endpoint, tid, {
          taskId: tid,
          status: lastStatusRef.current,
          plannerStarted: true,
          frontDraft: frontInput,
          plannerEvents: (scenarioPlannerRef.current?.getEvents() as any) || [],
        });
      }
    } catch {}
  };

  const stopPlanner = () => {
    try { scenarioPlannerRef.current?.stop(); } catch {}
    try { scenarioPlannerOffRef.current?.(); } catch {}
    scenarioPlannerOffRef.current = null;
    scenarioPlannerRef.current = null;
    setPlannerThinking(false);
    dispatch({ type: 'setPlannerStarted', started: false });
    // Persist existing event log per-task (do not clear)
    try {
      const tid = taskRef.current?.getTaskId();
      if (endpoint && tid) {
        saveSession(endpoint, { taskId: tid, status: lastStatusRef.current });
        saveTaskSession(endpoint, tid, {
          taskId: tid,
          status: lastStatusRef.current,
          plannerStarted: false,
          frontDraft: frontInput,
          plannerEvents: (eventLog as any) || [],
        });
      }
    } catch {}
  };

  const cancelTask = async (opts?: { reconnect?: boolean }) => {
    const task = taskRef.current;
    const tidBefore = task?.getTaskId();
    if (tidBefore && task) {
      try { await task.cancel(); }
      catch (e: any) { dispatch({ type: "error", error: String(e?.message ?? e) }); }
    }

    // Stop planner and cleanup streams
    try { scenarioPlannerRef.current?.stop(); } catch {}
    scenarioPlannerRef.current = null;
    try { ptStreamAbort.current?.abort(); ptStreamAbort.current = null; } catch {}
    ptSendInFlight.current = false;
    
    // Clear task client local state and destroy any polling loops (A2A/MCP)
    try { (taskRef.current as any)?.destroy?.(); } catch {}
    try { taskRef.current?.clearLocal(); } catch {}
    taskRef.current = null as any;
    clientRef.current = null;

    // Clear session persistence and local UI state (use tid captured before clearLocal)
    try { if (tidBefore) removeTaskSession(endpoint, tidBefore); } catch {}
    removeSession(endpoint);
    // Purge non-user attachments (keep only user uploads)
    try { vaultRef.current.purgeBySource(['agent','remote-agent']); } catch {}
    // Clear planner event log and any cached preloaded events
    preloadedEventsRef.current = null;
    setEventLog([]);
    dispatch({ type: "clearConversation" });
    setFrontInput("");
    // Reset endpoint card state to avoid stale UI
    setCard(null);
    setCardLoading(false);

    // Mark as disconnected to force a clean reconnect with a new task client
    // The auto-connect effect will recreate clients using the current endpoint/protocol
    dispatch({ type: 'reset' });

    // If explicitly requested (user action), immediately reconnect to current endpoint/protocol
    // to avoid relying on debounce timing or other effects
    if (opts?.reconnect) {
      const ep = (endpoint || '').trim();
      if (ep) {
        try { await handleConnect(ep, protocol); } catch {}
      }
    }

    // After reset, if a scenario URL is set, refetch it to pick up
    // any updates while preserving stored role/tool selections.
    try {
      if (scenarioUrl && scenarioUrl.trim()) {
        await onLoadScenarioUrl();
      }
    } catch {}
  };

  // UI handler for the Reset button: clear + immediate reconnect for a fresh planner
  const onResetClient = () => { void cancelTask({ reconnect: true }); };

  const sendFrontMessage = async (text: string) => {
    if (!text.trim()) return;
    console.log("Sending front message:", text);
    try { scenarioPlannerRef.current?.recordUserReply(text); } catch {}
    setFrontInput("");
    signalEvent('front-send');
  };

  // Scenario URL loader and agent selection
  const onLoadScenarioUrl = async () => {
    const url = scenarioUrl.trim();
    if (!url) return;
    try {
      const res = await fetch(url, { cache: 'no-cache', headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) throw new Error(`Scenario fetch failed: ${res.status}`);
      const j = await res.json();
      const cfg = j?.config ?? j;
      setScenarioConfig(cfg);
      const agents: string[] = Array.isArray(j?.config?.agents)
        ? (j.config.agents as any[]).map((a) => String(a?.agentId || '')).filter(Boolean)
        : Array.isArray(j?.agents)
          ? (j.agents as any[]).map((a) => String(a?.agentId || '')).filter(Boolean)
          : [];
      setScenarioAgents(agents);
      // Restore or initialize agent selection, and persist per-URL
      let planner: string | undefined;
      let counterpart: string | undefined;
      try {
        const key = scenarioKey(url);
        const raw = localStorage.getItem(key);
        const stored = raw ? JSON.parse(raw) : null;
        planner = stored?.planner && agents.includes(stored.planner) ? stored.planner : undefined;
        counterpart = stored?.counterpart && agents.includes(stored.counterpart) ? stored.counterpart : undefined;
      } catch {}
      if (!planner && agents.length) planner = agents[0];
      if (!counterpart) {
        if (agents.length === 2) counterpart = agents.find((a) => a !== planner);
        else if (agents.length > 1) counterpart = agents.find((a) => a !== planner);
      }
      setSelectedPlannerAgentId(planner);
      setSelectedCounterpartAgentId(counterpart);
      try { localStorage.setItem(scenarioKey(url), JSON.stringify({ planner, counterpart })); } catch {}

      // Initialize enabled tools for the selected planner; restore if persisted (per URL + agent)
      try {
        const agentDef = Array.isArray(cfg?.agents) ? cfg.agents.find((a: any) => a?.agentId === planner) : null;
        const allTools: string[] = Array.isArray(agentDef?.tools)
          ? agentDef.tools.map((t: any) => String(t?.toolName || t?.name || '')).filter(Boolean)
          : [];
        const toolsRaw = localStorage.getItem(scenarioToolsKey(url, planner));
        if (toolsRaw) {
          const saved: string[] = JSON.parse(toolsRaw);
          const intersect = Array.isArray(saved) ? saved.filter(n => allTools.includes(n)) : [];
          setEnabledTools(intersect.length ? intersect : allTools);
        } else {
          setEnabledTools(allTools);
        }
      } catch {}
    } catch (e: any) { console.error('Scenario load error', e); }
  };

  const onSelectPlannerAgentId = (id: string) => {
    setSelectedPlannerAgentId(id);
    let nextCounter = selectedCounterpartAgentId;
    if (scenarioAgents.length === 2) {
      nextCounter = scenarioAgents.find((a) => a !== id);
      setSelectedCounterpartAgentId(nextCounter);
    } else if (scenarioAgents.length > 1 && selectedCounterpartAgentId === id) {
      nextCounter = scenarioAgents.find((a) => a !== id);
      setSelectedCounterpartAgentId(nextCounter);
    }
    if (scenarioUrl.trim()) {
      try { localStorage.setItem(scenarioKey(scenarioUrl), JSON.stringify({ planner: id, counterpart: nextCounter })); } catch {}
    }
    // Scrub prefill params so reloads don't override user selection
    try { clearHashParams(['plannerAgentId','counterpartAgentId']); } catch {}
    // Update enabled tools default for selected agent
    try {
      const cfg = scenarioConfig as any;
      const agent = cfg?.agents?.find((a: any) => a?.agentId === id);
      const tools: string[] = Array.isArray(agent?.tools)
        ? agent.tools.map((t: any) => String(t?.toolName || t?.name || '')).filter(Boolean)
        : [];
      // Restore per-URL+agent if saved; otherwise enable all by default
      const savedRaw = scenarioUrl.trim() ? localStorage.getItem(scenarioToolsKey(scenarioUrl.trim(), id)) : null;
      if (savedRaw) {
        try {
          const saved: string[] = JSON.parse(savedRaw);
          const intersect = Array.isArray(saved) ? saved.filter(n => tools.includes(n)) : [];
          setEnabledTools(intersect.length ? intersect : tools);
        } catch { setEnabledTools(tools); }
      } else {
        setEnabledTools(tools);
      }
    } catch {}
  };

  // Persist enabled tools per-URL
  useEffect(() => {
    const url = scenarioUrl.trim();
    const agent = selectedPlannerAgentId;
    if (!url || !agent) return;
    try { localStorage.setItem(scenarioToolsKey(url, agent), JSON.stringify(enabledTools)); } catch {}
  }, [enabledTools, scenarioUrl, selectedPlannerAgentId]);

  // Auto-load scenario when URL is present/changes
  useEffect(() => {
    if (debouncedScenarioUrl && debouncedScenarioUrl.trim()) {
      onLoadScenarioUrl();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedScenarioUrl]);

  // Ensure scenario is (re)fetched after connect/reset when a URL is present
  useEffect(() => {
    if (model.connected && debouncedScenarioUrl && debouncedScenarioUrl.trim()) {
      onLoadScenarioUrl();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.connected]);

  

  const currentTools = (() => {
    try {
      const cfg = scenarioConfig as any;
      const agent = cfg?.agents?.find((a: any) => a?.agentId === selectedPlannerAgentId);
      return Array.isArray(agent?.tools)
        ? agent.tools.map((t: any) => ({ name: String(t?.toolName || t?.name || ''), description: t?.description ? String(t.description) : '' })).filter((t: any) => t.name)
        : [];
    } catch { return []; }
  })();

  const onToggleTool = (name: string, enabled: boolean) => {
    setEnabledTools((prev) => {
      const set = new Set(prev);
      if (enabled) set.add(name); else set.delete(name);
      return Array.from(set);
    });
  };
const onAttachFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const rec = await vaultRef.current.addFile(file);
      if (model.summarizeOnUpload) {
        summarizerRef.current?.queueAnalyze(rec.name, { priority: rec.priority || false });
      }
    }
    signalEvent('attachments');
    setAttachmentUpdateTrigger(prev => prev + 1);
  };

  const onAnalyzeAttachment = (name: string) => {
    summarizerRef.current?.queueAnalyze(name, { priority: true });
  };

  const openBase64Attachment = (name: string, mimeType: string, bytes?: string, uri?: string) => {
    try {
      // Fallback: if no bytes/uri provided by the button, try to resolve from vault by name
      if (!bytes && !uri && name) {
        try {
          const rec = vaultRef.current.getByName(name);
          if (rec) {
            bytes = rec.bytes;
            // Always prefer the vault's recorded MIME type for accurate rendering
            mimeType = rec.mimeType;
          }
        } catch {}
      }

      if (bytes) {
        let safeMime = mimeType || 'application/octet-stream';
        // Ensure text types specify UTF-8 so browsers render correctly
        if (/^text\//i.test(safeMime) && !/charset=/i.test(safeMime)) {
          safeMime = `${safeMime}; charset=utf-8`;
        }
        if (/^data:[^;]+;base64,/.test(bytes)) {
          window.open(bytes, '_blank');
          return;
        }
        const bin = atob(bytes);
        const len = bin.length;
        const buf = new Uint8Array(len);
        for (let i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
        const blob = new Blob([buf], { type: safeMime });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return;
      }
      if (uri) {
        const base = API_BASE;
        const full = uri.startsWith('http') ? uri : `${base}${uri}`;
        window.open(full, '_blank');
        return;
      }
      // Nothing to open; optionally surface a console note for debugging
      try { console.warn('[AttachmentOpen] No bytes/uri available for', name); } catch {}
    } catch (e) {
      try { console.warn('[AttachmentOpen] error', e); } catch {}
    }
  };
  
  // Deprecated: external scenario detector is no longer used to populate instructions

  return (
    <AppLayout title="Conversational Client">
      <div className="w-full">
          
          {/* Main Step Flow Section */}
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 mb-8">
          <StepFlow
            // Connection props
            endpoint={endpoint}
            onEndpointChange={handleEndpointChange}
            protocol={protocol}
            onProtocolChange={setProtocol}
            status={model.status}
            taskId={model.taskId}
            connected={model.connected}
            error={model.error}
            card={card}
            cardLoading={cardLoading}
            onCancelTask={onResetClient}
            
            // Configuration props
            instructions={instructions}
            onInstructionsChange={setInstructions}
            scenarioUrl={scenarioUrl}
            onScenarioUrlChange={handleScenarioUrlChange}
            // Manual load is redundant; auto-load via URL change
            scenarioAgents={scenarioAgents}
            selectedPlannerAgentId={selectedPlannerAgentId}
            onSelectPlannerAgentId={onSelectPlannerAgentId}
            selectedCounterpartAgentId={selectedCounterpartAgentId}
            tools={currentTools}
            enabledTools={enabledTools}
            onToggleTool={onToggleTool}
            providers={providers}
            selectedModel={selectedModel}
            onSelectedModelChange={(m) => { setSelectedModel(m); clearHashParams(['defaultModel']); }}
            plannerStarted={model.plannerStarted}
            onStartPlanner={startPlanner}
            onStopPlanner={stopPlanner}
              onLoadScenario={undefined}
              attachments={{
                vault: vaultRef.current,
                onFilesSelect: onAttachFiles,
                onAnalyze: onAnalyzeAttachment,
                onOpenAttachment: openBase64Attachment,
                summarizeOnUpload: model.summarizeOnUpload,
                onToggleSummarize: (on) => dispatch({ type: "toggleSummarizeOnUpload", on }),
              }}
            />
          </div>

          {/* Conversations Section */}
          <DualConversationView
              frontMessages={derivedFront}
              agentLog={derivedAgent}
              plannerStarted={model.plannerStarted}
              onOpenAttachment={openBase64Attachment}
              input={frontInput}
              onInputChange={setFrontInput}
              onSendMessage={sendFrontMessage}
              connected={model.connected}
              busy={model.busy}
              yourTurn={yourTurn}
            />

          {/* Event Log Section */}
          <div className="mt-8">
            <EventLogView events={eventLog} busy={plannerThinking} />
          </div>
      </div>
    </AppLayout>
  );
}
