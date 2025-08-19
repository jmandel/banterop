import React, { useEffect, useReducer, useRef, useState } from "react";
import { AppLayout } from "../ui";
import { A2AClient } from "./a2a-client";
import type { A2AStatus } from "./a2a-types";
import { AttachmentVault } from "./attachments-vault";
import { AttachmentSummarizer } from "./attachment-summaries";
import { DualConversationView } from "./components/Conversations/DualConversationView";
import type { UnifiedEvent as PlannerUnifiedEvent } from "./components/EventLogView";
import { EventLogView } from "./components/EventLogView";
import { StepFlow } from "./components/StepFlow/StepFlow";
import { ScenarioPlannerV2 } from "./planner-scenario";
import { createTaskClient, detectProtocolFromUrl, type Protocol } from "./protocols";
import type { TaskClientLike } from "./protocols/task-client";
import { useDebounce } from "./useDebounce";

type AgentLogEntry = { 
  id: string; 
  role: "planner" | "agent"; 
  text: string; 
  partial?: boolean; 
  attachments?: Array<{ 
    name: string; 
    mimeType: string; 
    bytes?: string; 
    uri?: string;
  }>; 
};

type FrontMsg = { id: string; role: "you" | "planner" | "system"; text: string };
type PlannerMode = "passthrough" | "autostart" | "approval";

type Model = {
  connected: boolean;
  endpoint: string;
  protocol: Protocol;
  taskId?: string;
  status: A2AStatus | "initializing";
  front: FrontMsg[];
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
  | { type: "frontAppend"; msg: FrontMsg }
  | { type: "system"; text: string }
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
  front: [],
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
    case "frontAppend":
      return { ...m, front: [...m.front, a.msg] };
    case "system":
      return { ...m, front: [...m.front, { id: crypto.randomUUID(), role: "system", text: a.text }] };
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
        front: [],
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
  const initialEndpoint = localStorage.getItem("a2a.endpoint") || "";
  const inferredProto = (detectProtocolFromUrl(initialEndpoint) ? "auto" : ("a2a" as Protocol));
  const initialProto = (localStorage.getItem("a2a.protocol") as Protocol) || inferredProto;
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
  const [selectedModel, setSelectedModel] = useState<string>(() => localStorage.getItem("a2a.planner.model") || "");
  const [summarizerModel, setSummarizerModel] = useState<string>(() => localStorage.getItem("a2a.attach.model") || "");

  const [model, dispatch] = useReducer(reducer, initModel(initialEndpoint, initialProto));

  const clientRef = useRef<A2AClient | null>(null);
  const vaultRef = useRef(new AttachmentVault());
  // const providerRef = useRef<ServerLLMProvider | null>(null);
  const taskRef = useRef<TaskClientLike | null>(null);
  // const plannerRef = useRef<Planner | null>(null);
  const scenarioPlannerRef = useRef<ScenarioPlannerV2 | null>(null);
  const scenarioPlannerOffRef = useRef<(() => void) | null>(null);
  const summarizerRef = useRef<AttachmentSummarizer | null>(null);
  const summarizerModelRef = useRef<string>(summarizerModel);
  const plannerModeRef = useRef<PlannerMode>("autostart");
  const plannerStartedRef = useRef<boolean>(false);
  const mirroredAgentIdsRef = useRef<Set<string>>(new Set());

  const [agentLog, setAgentLog] = useState<AgentLogEntry[]>([]);
  // Scenario URL + agent selection
  const [scenarioUrl, setScenarioUrl] = useState<string>(() => localStorage.getItem("a2a.scenario.url") || "");
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

  // Live ref of front messages to avoid stale-closure reads in Planner
  const frontMsgsRef = useRef<FrontMsg[]>([]);
  useEffect(() => { frontMsgsRef.current = model.front; }, [model.front]);

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
      saveSession(endpoint, {
        taskId: tid,
        status: st,
        plannerStarted: plannerStartedRef.current,
        front: frontMsgsRef.current,
        frontDraft: frontInput,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.front, frontInput]);

  useEffect(() => {
    localStorage.setItem("a2a.endpoint", endpoint);
  }, [endpoint]);
  useEffect(() => { try { localStorage.setItem("a2a.protocol", protocol); } catch {} }, [protocol]);

  useEffect(() => { try { localStorage.setItem("a2a.planner.instructions", instructions); } catch {} }, [instructions]);
  // No longer persisting background/goals by default
  useEffect(() => { try { localStorage.setItem("a2a.planner.model", selectedModel); } catch {} }, [selectedModel]);
  useEffect(() => { try { localStorage.setItem("a2a.attach.model", summarizerModel); } catch {} }, [summarizerModel]);
  
  // Sync planner settings to localStorage
  useEffect(() => { try { localStorage.setItem("a2a.planner.mode", model.plannerMode); } catch {} }, [model.plannerMode]);
  useEffect(() => { plannerModeRef.current = model.plannerMode; }, [model.plannerMode]);
  useEffect(() => { plannerStartedRef.current = model.plannerStarted; }, [model.plannerStarted]);
  useEffect(() => { try { localStorage.setItem("a2a.planner.summarizeOnUpload", String(model.summarizeOnUpload)); } catch {} }, [model.summarizeOnUpload]);
  useEffect(() => { try { localStorage.setItem("a2a.scenario.url", scenarioUrl); } catch {} }, [scenarioUrl]);

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
    front?: FrontMsg[];
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

  // Auto-connect when debounced endpoint or protocol changes
  useEffect(() => {
    if (debouncedEndpoint !== model.endpoint || !model.connected || protocol !== model.protocol) {
      console.log("[App] Auto-connecting to:", debouncedEndpoint, 'protocol=', protocol);
      handleConnect(debouncedEndpoint, protocol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedEndpoint, protocol]);

  // Auto-detect protocol from URL and update selector if needed
  useEffect(() => {
    const detected = detectProtocolFromUrl(debouncedEndpoint);
    if (detected && protocol !== detected) {
      setProtocol(detected as Protocol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedEndpoint]);

  // Load provider list
  useEffect(() => {
    (async () => {
      try {
        const base = (window as any)?.__APP_CONFIG__?.API_BASE || "http://localhost:3000/api";
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
        if (!summarizerModel) {
          const first = filtered.flatMap((p: any) => p.models || [])[0];
          if (first) setSummarizerModel(first);
        }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep summarizer model ref in sync
  useEffect(() => { summarizerModelRef.current = summarizerModel; }, [summarizerModel]);

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
    dispatch({ type: "connect", endpoint: endpointUrl, protocol: proto });

    clientRef.current = new A2AClient(endpointUrl);
    const taskClient = createTaskClient(proto, endpointUrl);
    taskRef.current = taskClient;

    // Attachment summarizer (background)
    summarizerRef.current = new AttachmentSummarizer(() => summarizerModelRef.current || undefined, vaultRef.current);
    summarizerRef.current.onUpdate((_name) => {
      // Update attachment UI when summaries arrive; do not trigger planner ticks
      setAttachmentUpdateTrigger(prev => prev + 1);
    });

    const updateAgentLogFromTask = () => {
      const t = taskRef.current?.getTask();
      const hist = t?.history || [];
      const entries: AgentLogEntry[] = hist.map((m) => {
        const text = (m.parts || []).filter((p: any) => p?.kind === 'text').map((p: any) => p.text).join('\n') || '';
        const atts = (m.parts || []).filter((p:any)=>p?.kind==='file' && p?.file).map((p:any)=>({ name: String(p.file.name||'attachment'), mimeType: String(p.file.mimeType||'application/octet-stream'), bytes: p.file.bytes, uri: p.file.uri }));
        return { id: m.messageId, role: m.role === 'user' ? 'planner' : 'agent', text, attachments: atts };
      });
      setAgentLog(entries);
    };
    taskClient.on('new-task', () => {
      const curTask = taskRef.current?.getTaskId();
      if (lastTaskIdRef.current !== curTask) {
        lastTaskIdRef.current = curTask;
        dispatch({ type: "setTask", taskId: curTask });
      }
      updateAgentLogFromTask();
      // Mirror any new agent attachments into the vault for planner availability
      try {
        const t = taskRef.current?.getTask();
        const hist = t?.history || [];
        for (const m of hist) {
          if (m.role !== 'agent') continue;
          const msgId = String(m.messageId || '');
          if (!msgId || mirroredAgentIdsRef.current.has(msgId)) continue;
          const parts = Array.isArray(m.parts) ? m.parts : [];
          let mirrored = false;
          for (const p of parts) {
            if (p?.kind === 'file' && p?.file) {
              const name = String(p.file.name || 'attachment');
              const mimeType = String(p.file.mimeType || 'application/octet-stream');
              const bytes = typeof p.file.bytes === 'string' ? p.file.bytes : '';
              try {
                const rec = vaultRef.current.addFromAgent(name, mimeType, bytes || '');
                mirrored = true;
                // Auto-summarize new agent attachments if no summary present
                if (!rec.summary) {
                  summarizerRef.current?.queueAnalyze(rec.name, { priority: true });
                }
              } catch {}
            }
          }
          if (mirrored) {
            mirroredAgentIdsRef.current.add(msgId);
            setAttachmentUpdateTrigger(prev => prev + 1);
          }
        }
      } catch {}
      signalEvent('store');
    });
    taskClient.on('new-task', () => {
      const st = taskRef.current?.getStatus();
      if (st && lastStatusRef.current !== st) {
        lastStatusRef.current = st;
        dispatch({ type: 'status', status: st });
        if (st === 'completed') {
          dispatch({ type: 'system', text: '— conversation completed —' });
          // Do not stop planner automatically; allow final user communication
          // Abort any active streams
          try {
            ptStreamAbort.current?.abort();
            ptStreamAbort.current = null;
          } catch {}
          ptSendInFlight.current = false;
        }
        if (st === 'failed') {
          dispatch({ type: 'system', text: '— conversation failed —' });
          // Stop the planner when task fails
          try { scenarioPlannerRef.current?.stop(); } catch {}
          scenarioPlannerRef.current = null;
          dispatch({ type: 'setPlannerStarted', started: false });
          // Abort any active streams
          try {
            ptStreamAbort.current?.abort();
            ptStreamAbort.current = null;
          } catch {}
          ptSendInFlight.current = false;
        }
        if (st === 'canceled') {
          dispatch({ type: 'system', text: '— conversation canceled —' });
          // Stop the planner when task is canceled
          try { scenarioPlannerRef.current?.stop(); } catch {}
          scenarioPlannerRef.current = null;
          dispatch({ type: 'setPlannerStarted', started: false });
          // Abort any active streams
          try {
            ptStreamAbort.current?.abort();
            ptStreamAbort.current = null;
          } catch {}
          ptSendInFlight.current = false;
        }
        // Persist session on status changes
        saveSession(endpointUrl, {
          taskId: taskRef.current?.getTaskId(),
          status: st,
          plannerStarted: plannerStartedRef.current,
          front: frontMsgsRef.current,
          frontDraft: frontInput,
        });
      }
    });

    // Fetch agent info: A2A uses agent-card; MCP lists tools
    if (proto === 'a2a') {
      (async () => {
        setCardLoading(true);
        try {
          const base = endpointUrl.replace(/\/+$/, "");
          const res = await fetch(`${base}/.well-known/agent-card.json`, { credentials: "include" });
          if (!res.ok) throw new Error(`Agent card fetch failed: ${res.status}`);
          setCard(await res.json());
        } catch (e: any) {
          setCard({ error: String(e?.message ?? e) });
        } finally {
          setCardLoading(false);
        }
      })();
    } else {
      (async () => {
        setCardLoading(true);
        try {
          const { listMcpTools } = await import('./protocols/mcp-utils');
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
    if (!targetTask) {
      const sess = loadSession(endpointUrl);
      if (sess?.taskId && sess.status && !['completed','failed','canceled'].includes(String(sess.status))) {
        targetTask = sess.taskId;
        // Preload front UI from session
        const savedFront = Array.isArray(sess.front) ? sess.front : [];
        for (const msg of savedFront) dispatch({ type: 'frontAppend', msg });
        if (typeof sess.frontDraft === 'string') setFrontInput(sess.frontDraft);
        // Preload planner events into UI and ref for later start
        const savedEvents = Array.isArray(sess.plannerEvents) ? (sess.plannerEvents as any) : [];
        if (savedEvents.length) {
          setEventLog(savedEvents);
          preloadedEventsRef.current = savedEvents as any;
        }
      }
    }

    if (targetTask) {
      try {
        await taskClient.resume(targetTask);
        dispatch({ type: "setTask", taskId: targetTask });
        const sess = loadSession(endpointUrl);
        if (sess?.plannerStarted) {
          // Defer to allow initial snapshot to land
          setTimeout(() => { try { startPlanner(sess?.plannerEvents || []); } catch {} }, 0);
        }
      } catch (e: any) {
        dispatch({ type: "error", error: String(e?.message ?? e) });
      }
    }
  };

  const startPlanner = (preloadedEvents?: PlannerUnifiedEvent[]) => {
    if (scenarioPlannerRef.current) return;
    const task = taskRef.current!;
    const getApiBase = () => (window as any)?.__APP_CONFIG__?.API_BASE || "http://localhost:3000/api";
    const orch = new ScenarioPlannerV2({
      task,
      vault: vaultRef.current,
      getApiBase,
      getEndpoint: () => endpoint,
      getPlannerAgentId: () => selectedPlannerAgentId,
      getCounterpartAgentId: () => selectedCounterpartAgentId,
      getEnabledTools: () => (currentTools.filter((t: { name: string; description?: string }) => enabledTools.includes(t.name))),
      getAdditionalInstructions: () => instructions,
      onSystem: (text) => dispatch({ type: "system", text }),
      onAskUser: (q) => dispatch({ type: "frontAppend", msg: { id: crypto.randomUUID(), role: "planner", text: q } }),
    });
    scenarioPlannerRef.current = orch;
    const preload = (preloadedEvents && preloadedEvents.length)
      ? preloadedEvents
      : (preloadedEventsRef.current && preloadedEventsRef.current.length ? preloadedEventsRef.current : []);
    if (preload && preload.length) {
      try { (orch as any).loadEvents(preloadedEvents as any); } catch {}
    }
    preloadedEventsRef.current = null;
    setEventLog(orch.getEvents() as any);
    const off = orch.onEvent((ev) => {
      setEventLog((prev) => {
        const next = [...prev, ev as any];
        saveSession(endpoint, {
          taskId: taskRef.current?.getTaskId(),
          status: lastStatusRef.current,
          plannerStarted: true,
          front: frontMsgsRef.current,
          frontDraft: frontInput,
          plannerEvents: next as any,
        });
        return next;
      });
    });
    scenarioPlannerOffRef.current = off;
    orch.start();
    signalEvent('planner-start');
    dispatch({ type: "setPlannerStarted", started: true });
    // Persist session snapshot
    saveSession(endpoint, {
      taskId: taskRef.current?.getTaskId(),
      status: lastStatusRef.current,
      plannerStarted: true,
      front: frontMsgsRef.current,
      frontDraft: frontInput,
      plannerEvents: (scenarioPlannerRef.current?.getEvents() as any) || [],
    });
  };

  const stopPlanner = () => {
    try { scenarioPlannerRef.current?.stop(); } catch {}
    try { scenarioPlannerOffRef.current?.(); } catch {}
    scenarioPlannerOffRef.current = null;
    scenarioPlannerRef.current = null;
    dispatch({ type: 'setPlannerStarted', started: false });
    // Persist existing event log (do not clear) so it survives reloads
    saveSession(endpoint, {
      taskId: taskRef.current?.getTaskId(),
      status: lastStatusRef.current,
      plannerStarted: false,
      front: frontMsgsRef.current,
      frontDraft: frontInput,
      plannerEvents: (eventLog as any) || [],
    });
  };

  const cancelTask = async () => {
    const task = taskRef.current;
    if (task?.getTaskId()) {
      try { await task.cancel(); }
      catch (e: any) { dispatch({ type: "error", error: String(e?.message ?? e) }); }
    }

    // Stop planner and cleanup streams
    try { scenarioPlannerRef.current?.stop(); } catch {}
    scenarioPlannerRef.current = null;
    try { ptStreamAbort.current?.abort(); ptStreamAbort.current = null; } catch {}
    ptSendInFlight.current = false;
    
    // Clear task client local state
    try { taskRef.current?.clearLocal(); } catch {}

    // Clear session persistence and local UI state
    removeSession(endpoint);
    dispatch({ type: "clearConversation" });
    setAgentLog([]);
    setFrontInput("");
  };

  const sendFrontMessage = async (text: string) => {
    if (!text.trim()) return;
    console.log("Sending front message:", text);
    dispatch({ type: "frontAppend", msg: { id: crypto.randomUUID(), role: "you", text } });
    try { scenarioPlannerRef.current?.recordUserReply(text); } catch {}
    setFrontInput("");
    signalEvent('front-send');
  };

  // Scenario URL loader and agent selection
  const onLoadScenarioUrl = async () => {
    const url = scenarioUrl.trim();
    if (!url) return;
    try {
      const res = await fetch(url);
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
    } catch (e: any) {
      dispatch({ type: 'system', text: `Scenario load error: ${String(e?.message ?? e)}` });
    }
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
      if (bytes) {
        const safeMime = mimeType || 'application/octet-stream';
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
        const base = (window as any)?.__APP_CONFIG__?.API_BASE || 'http://localhost:3000/api';
        const full = uri.startsWith('http') ? uri : `${base}${uri}`;
        window.open(full, '_blank');
        return;
      }
    } catch (e) {
      try { console.warn('[AttachmentOpen] error', e); } catch {}
    }
  };
  
  // Deprecated: external scenario detector is no longer used to populate instructions

  return (
    <AppLayout title="Conversational Interop Client">
      <div className="w-full">
          
          {/* Main Step Flow Section */}
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 mb-8">
          <StepFlow
            // Connection props
            endpoint={endpoint}
            onEndpointChange={setEndpoint}
            protocol={protocol}
            onProtocolChange={setProtocol}
            status={model.status}
            taskId={model.taskId}
            connected={model.connected}
            error={model.error}
            card={card}
            cardLoading={cardLoading}
            onCancelTask={cancelTask}
            
            // Configuration props
            instructions={instructions}
            onInstructionsChange={setInstructions}
            scenarioUrl={scenarioUrl}
            onScenarioUrlChange={setScenarioUrl}
            // Manual load is redundant; auto-load via URL change
            scenarioAgents={scenarioAgents}
            selectedPlannerAgentId={selectedPlannerAgentId}
            onSelectPlannerAgentId={onSelectPlannerAgentId}
            selectedCounterpartAgentId={selectedCounterpartAgentId}
            tools={currentTools}
            enabledTools={enabledTools}
            onToggleTool={onToggleTool}
            providers={providers}
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
                summarizerModel,
                onSummarizerModelChange: setSummarizerModel,
              }}
            />
          </div>

          {/* Conversations Section */}
          <DualConversationView
              frontMessages={model.front}
              agentLog={agentLog}
              plannerStarted={model.plannerStarted}
              onOpenAttachment={openBase64Attachment}
              input={frontInput}
              onInputChange={setFrontInput}
              onSendMessage={sendFrontMessage}
              connected={model.connected}
              busy={model.busy}
              yourTurn={model.status === 'input-required'}
            />

          {/* Event Log Section */}
          <div className="mt-8">
            <EventLogView events={eventLog} />
          </div>
      </div>
    </AppLayout>
  );
}
