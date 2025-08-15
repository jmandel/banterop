import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { A2AStatus } from "./a2a-types";
import { A2AClient } from "./a2a-client";
import { AttachmentVault } from "./attachments-vault";
import { Planner } from "./planner";
import { ServerLLMProvider } from "./llm-provider";
type AgentLogEntry = { id: string; role: "planner" | "agent"; text: string; partial?: boolean; attachments?: Array<{ name: string; mimeType: string; bytes?: string; uri?: string }>; };
import { A2ATaskClient } from "./a2a-task-client";
import { AttachmentSummarizer } from "./attachment-summaries";
import { useDebounce } from "./useDebounce";

type FrontMsg = { id: string; role: "you" | "planner" | "system"; text: string };

type PlannerMode = "passthrough" | "autostart" | "approval";

type Model = {
  connected: boolean;
  endpoint: string;
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
  | { type: "connect"; endpoint: string }
  | { type: "setTask"; taskId?: string }
  | { type: "status"; status: A2AStatus | "initializing" }
  | { type: "frontAppend"; msg: FrontMsg }
  | { type: "system"; text: string }
  | { type: "busy"; busy: boolean }
  | { type: "error"; error?: string }
  | { type: "setPlannerMode"; mode: PlannerMode }
  | { type: "setPlannerStarted"; started: boolean }
  | { type: "toggleSummarizeOnUpload"; on: boolean }
  | { type: "reset" };

const initModel = (endpoint: string): Model => ({
  connected: false,
  endpoint,
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
      return { ...m, connected: true, endpoint: a.endpoint, error: undefined };
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
    case "reset":
      return { ...initModel(m.endpoint) };
    default:
      return m;
  }
}

const DEFAULT_INSTRUCTIONS =
  "Primary goal: help the user accomplish their task with minimal back-and-forth. " +
  "Prefer concise messages to the agent; attach files by name when needed. Ask the user only when necessary.";

const DEFAULT_GOALS =
  "Context/Background & Goals:\n" +
  "- Paste relevant background and end goals here.\n" +
  "- The planner may lead, optionally asking before the first send per policy.";

export default function App() {
  const initialEndpoint = localStorage.getItem("a2a.endpoint") || "";
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const debouncedEndpoint = useDebounce(endpoint, 500); // Debounce URL changes by 500ms
  const [resumeTask, setResumeTask] = useState("");
  const [instructions, setInstructions] = useState(
    () => localStorage.getItem("a2a.planner.instructions") || DEFAULT_INSTRUCTIONS
  );
  const [goals, setGoals] = useState(() => localStorage.getItem("a2a.planner.goals") || DEFAULT_GOALS);
  const [providers, setProviders] = useState<Array<{ name: string; models: string[] }>>([]);
  const [selectedModel, setSelectedModel] = useState<string>(() => localStorage.getItem("a2a.planner.model") || "");
  const [summarizerModel, setSummarizerModel] = useState<string>(() => localStorage.getItem("a2a.attach.model") || "");

  const [model, dispatch] = useReducer(reducer, initModel(initialEndpoint));

  const clientRef = useRef<A2AClient | null>(null);
  const vaultRef = useRef(new AttachmentVault());
  const providerRef = useRef<ServerLLMProvider | null>(null);
  const taskRef = useRef<A2ATaskClient | null>(null);
  const plannerRef = useRef<Planner | null>(null);
  const summarizerRef = useRef<AttachmentSummarizer | null>(null);
  const summarizerModelRef = useRef<string>(summarizerModel);
  const plannerModeRef = useRef<PlannerMode>("autostart");
  const mirroredAgentIdsRef = useRef<Set<string>>(new Set());

  const [agentLog, setAgentLog] = useState<AgentLogEntry[]>([]);
  const [card, setCard] = useState<any | null>(null);
  const [cardLoading, setCardLoading] = useState(false);

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
  const frontLogRef = useRef<HTMLDivElement | null>(null);
  const agentLogRef = useRef<HTMLDivElement | null>(null);
  const ptSendInFlight = useRef(false);
  const ptStreamAbort = useRef<AbortController | null>(null);
  const lastStatusRef = useRef<A2AStatus | "initializing">("initializing");
  const lastTaskIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    localStorage.setItem("a2a.endpoint", endpoint);
  }, [endpoint]);

  useEffect(() => { try { localStorage.setItem("a2a.planner.instructions", instructions); } catch {} }, [instructions]);
  useEffect(() => { try { localStorage.setItem("a2a.planner.goals", goals); } catch {} }, [goals]);
  useEffect(() => { try { localStorage.setItem("a2a.planner.model", selectedModel); } catch {} }, [selectedModel]);
  useEffect(() => { try { localStorage.setItem("a2a.attach.model", summarizerModel); } catch {} }, [summarizerModel]);
  
  // Sync planner settings to localStorage
  useEffect(() => { try { localStorage.setItem("a2a.planner.mode", model.plannerMode); } catch {} }, [model.plannerMode]);
  useEffect(() => { plannerModeRef.current = model.plannerMode; }, [model.plannerMode]);
  useEffect(() => { try { localStorage.setItem("a2a.planner.summarizeOnUpload", String(model.summarizeOnUpload)); } catch {} }, [model.summarizeOnUpload]);

  useEffect(() => { const el = frontLogRef.current; if (el) el.scrollTop = el.scrollHeight; }, [model.front.length]);
  useEffect(() => { const el = agentLogRef.current; if (el) el.scrollTop = el.scrollHeight; }, [agentLog.length]);

  // Auto-connect when debounced endpoint changes
  useEffect(() => {
    if (debouncedEndpoint !== model.endpoint || !model.connected) {
      console.log("[App] Auto-connecting to:", debouncedEndpoint);
      handleConnect(debouncedEndpoint);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedEndpoint]);

  // Load provider list (optional helper)
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

  const handleConnect = async (endpointUrl: string) => {
    if (!endpointUrl.trim()) {
      // Clear state if no endpoint
      dispatch({ type: "reset" });
      lastStatusRef.current = "submitted";
      lastTaskIdRef.current = undefined;
      clientRef.current = null;
      taskRef.current = null;
      plannerRef.current?.stop();
      plannerRef.current = null;
      return;
    }
    
    dispatch({ type: "reset" });
    lastStatusRef.current = "submitted";
    lastTaskIdRef.current = undefined;
    dispatch({ type: "connect", endpoint: endpointUrl });

    const client = new A2AClient(endpointUrl);
    clientRef.current = client;

    // Provider is created when planner starts (and only if not in passthrough mode)

    const taskClient = new A2ATaskClient(endpointUrl);
    taskRef.current = taskClient;

    // Attachment summarizer (background)
    summarizerRef.current = new AttachmentSummarizer(() => summarizerModelRef.current || undefined, vaultRef.current);
    summarizerRef.current.onUpdate((name) => {
      // Wake planner when summaries refresh
      signalEvent('summarizer');
      // force small UI update
      setFrontInput((x) => x);
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
      signalEvent('store');
    });
    taskClient.on('new-task', () => {
      const st = taskRef.current?.getStatus();
      if (st && lastStatusRef.current !== st) {
        lastStatusRef.current = st;
        dispatch({ type: 'status', status: st });
        if (st === 'input-required') dispatch({ type: 'system', text: '— your turn now —' });
        if (st === 'completed') dispatch({ type: 'system', text: '— conversation completed —' });
        if (st === 'failed') dispatch({ type: 'system', text: '— conversation failed —' });
        if (st === 'canceled') dispatch({ type: 'system', text: '— conversation canceled —' });
      }
    });

    // Fetch agent card (UX)
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

    // Resume task if provided
    if (resumeTask.trim()) {
      try {
        await taskClient.resume(resumeTask.trim());
        dispatch({ type: "setTask", taskId: resumeTask.trim() });
      } catch (e: any) {
        dispatch({ type: "error", error: String(e?.message ?? e) });
      }
    }

  };

  const startPlanner = () => {
    const client = clientRef.current!;
    // Instantiate provider only for non-passthrough modes
    if (model.plannerMode !== "passthrough") {
      if (!providerRef.current) providerRef.current = new ServerLLMProvider(() => selectedModel || undefined);
    } else {
      providerRef.current = null;
    }

    if (plannerRef.current) return;
    const task = taskRef.current!;
    const orch = new Planner({
      provider: model.plannerMode === "passthrough" ? undefined : providerRef.current!,
      task: task,
      vault: vaultRef.current,
      getPolicy: () => ({
        has_task: !!task.getTaskId(),
        planner_mode: model.plannerMode,
      }),
      getInstructions: () => instructions,
      getGoals: () => goals,
      getUserMediatorRecent: () =>
        frontMsgsRef.current.slice(-30).map((m) => ({
          role: m.role === "you" ? "user" : m.role === "planner" ? "planner" : "system",
          text: m.text,
        })),
      getCounterpartHint: () => {
        try {
          const skill = (card as any)?.skills?.[0];
          const hasTask = !!task.getTaskId();
          if (skill?.description && typeof skill.description === 'string') {
            const d: string = skill.description as string; // e.g., "Open a conversation with <id> acting for \"<principal>\" — ..."
            const msg = hasTask
              ? d.replace(/^Open a conversation with/i, 'Calling send_to_agent will continue the conversation with')
              : d.replace(/^Open a conversation with/i, 'Calling send_to_agent will begin a new conversation with');
            return msg;
          }
          // Fallback to generic description
          const desc = (card as any)?.description;
          if (typeof desc === 'string' && desc) {
            return hasTask
              ? `Calling send_to_agent will continue the conversation with the configured counterpart. ${desc}`
              : `Calling send_to_agent will begin a new conversation with the configured counterpart. ${desc}`;
          }
          return undefined;
        } catch { return undefined; }
      },
      waitNextEvent: waitNextEventFn,
      cancelTask: cancelTask,
      onSystem: (text) => dispatch({ type: "system", text }),
      onAskUser: (q) => dispatch({ type: "frontAppend", msg: { id: crypto.randomUUID(), role: "planner", text: q } }),
      onSendToAgentEcho: (_text) => {},
    });
    plannerRef.current = orch;
    orch.start();
    signalEvent('planner-start');
    dispatch({ type: "setPlannerStarted", started: true });
  };


  const cancelTask = async () => {
    const client = clientRef.current;
    const task = taskRef.current;
    if (!client || !task?.getTaskId()) return;
    try {
      await client.tasksCancel(task.getTaskId()!);
    } catch (e: any) {
      dispatch({ type: "error", error: String(e?.message ?? e) });
    }
  };

  // Front-stage composer
  const [frontInput, setFrontInput] = useState("");
  const sendFrontMessage = async (text: string) => {
    if (!text.trim()) return;
    console.log("Sending front message:", text);
    dispatch({ type: "frontAppend", msg: { id: crypto.randomUUID(), role: "you", text } });
    try { plannerRef.current?.recordUserReply?.(text); } catch {}
    setFrontInput("");
    
    // In passthrough mode, proactively send:
    // - If no task exists yet: start a streaming send to create task + subscribe
    // - Else: fire-and-forget message/send on existing task (resubscribe is already active)
    if (
      plannerModeRef.current === "passthrough" &&
      plannerRef.current &&
      clientRef.current &&
      taskRef.current &&
      (
        // Allow send if no stream in flight, or if we already have a task (we'll abort the old stream)
        !ptSendInFlight.current || !!taskRef.current.getTaskId()
      )
    ) {
      const parts = [{ kind: "text", text } as const];
      const taskId = taskRef.current.getTaskId();
      if (!taskId) {
        ptSendInFlight.current = true;
        (async () => {
          // Close any prior stream before starting a new one
          try {
            if (ptStreamAbort.current) {
              console.warn(`[SSEAbort] Passthrough: aborting prior send stream before first message (reason=new-initial-send)`);
              ptStreamAbort.current.abort();
            }
          } catch {}
          const ac = new AbortController();
          ptStreamAbort.current = ac;
          let gotAny = false;
          try {
            await taskRef.current!.startNew(parts as any);
            gotAny = true;
          } catch (e: any) {
            const msg = String(e?.message ?? e ?? "");
            if (!gotAny) dispatch({ type: "system", text: `stream error: ${msg || 'unknown'}` });
          } finally {
            if (ptStreamAbort.current === ac) ptStreamAbort.current = null;
            ptSendInFlight.current = false;
          }
        })();
      } else {
        (async () => { try { await taskRef.current!.send(parts as any); } catch (e:any) { dispatch({ type: 'system', text: `send error: ${String(e?.message ?? e)}` }); } })();
      }
    }

    signalEvent('front-send');
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
    // nudge UI
    setFrontInput((x) => x);
  };

  const statusPill = useMemo(() => {
    const s = model.status;
    const map: Record<A2AStatus | "initializing", { label: string; cls: string }> = {
      initializing: { label: "initializing…", cls: "" },
      submitted: { label: "submitted", cls: "" },
      working: { label: "working…", cls: "" },
      "input-required": { label: "your turn", cls: "warn" },
      completed: { label: "completed", cls: "green" },
      failed: { label: "failed", cls: "red" },
      canceled: { label: "canceled", cls: "" },
    };
    const m = map[s];
    return <span className={`pill ${m.cls}`}>{m.label}</span>;
  }, [model.status]);

  function fileIcon(mime: string): string {
    const m = (mime || "").toLowerCase();
    if (m.startsWith("image/")) return "🖼️";
    if (m.includes("pdf")) return "📄";
    if (m.startsWith("text/")) return "📃";
    if (m.includes("word") || m.includes("msword") || m.includes("officedocument")) return "📄";
    if (m.includes("sheet") || m.includes("excel")) return "📊";
    return "📎";
  }

  function openBase64Attachment(name: string, mimeType: string, bytes?: string, uri?: string) {
    try {
      if (bytes) {
        // Prefer Blob URLs to avoid browsers blocking data: URL popups
        const safeMime = mimeType || 'application/octet-stream';
        // If bytes was mistakenly a data URL, just open it directly
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
  }

  return (
    <div className="app">
      {/* Connection */}
      <div className="panel">
        <div className="row" style={{ gap: 12 }}>
          <div className="grow">
            <label>A2A Endpoint URL</label>
            <input type="text" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="http://localhost:3000/api/bridge/<config64>/a2a" />
          </div>
          {/* Resume Task - TODO: implement later
          <div style={{ minWidth: 220 }}>
            <label>Resume Task ID (optional)</label>
            <input type="text" value={resumeTask} onChange={(e) => setResumeTask(e.target.value)} placeholder="task-123" />
          </div>
          */}
        </div>
        <div className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
          <div className="status">
            Status: {statusPill} {model.taskId ? <span className="tiny"> • task: <span className="kbd">{model.taskId}</span></span> : null}
          </div>
          <div>
            <button className="ghost" onClick={cancelTask} disabled={!model.taskId}>Cancel Task</button>
          </div>
        </div>

        {/* Planner settings */}
        <div className="row" style={{ gap: 12, marginTop: 8 }}>
          <div className="grow">
            <label>Background & Goals</label>
            <textarea rows={3} value={goals} onChange={(e) => setGoals(e.target.value)} />
          </div>
          <div className="grow">
            <label>Planner Instructions</label>
            <textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </div>
          <div style={{ minWidth: 260 }}>
            <label>Planner Mode</label>
            <select 
              value={model.plannerMode} 
              onChange={(e) => dispatch({ type: "setPlannerMode", mode: e.target.value as PlannerMode })} 
              className="w-full"
              disabled={model.plannerStarted}
            >
              <option value="passthrough">Passthrough - Direct bridging to agent</option>
              <option value="autostart">Autostart - Planner initiates automatically</option>
              <option value="approval">Approval - Wait for user before starting</option>
            </select>
            {model.plannerMode !== "passthrough" && (
              <>
                <label style={{ marginTop: 6 }}>Planner Model</label>
                <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} className="w-full">
                  {providers.map((p) => (
                    <optgroup key={p.name} label={p.name}>
                      {(p.models || []).map((m) => (<option key={`${p.name}:${m}`} value={m}>{m}</option>))}
                    </optgroup>
                  ))}
                </select>
              </>
            )}

            <div className="row" style={{ marginTop: 8 }}>
              {!model.plannerStarted ? (
                <button className="primary" onClick={startPlanner} disabled={!model.connected} title={!model.connected ? "Not connected" : "Start planner"}>
                  Begin Planner
                </button>
              ) : (
                <button className="ghost" onClick={() => { plannerRef.current?.stop(); plannerRef.current = null; dispatch({ type: 'setPlannerStarted', started: false }); }}>Stop Planner</button>
              )}
            </div>
          </div>
        </div>

        <div className="tiny wrap" style={{ marginTop: 6, color: "var(--muted)" }}>
          Endpoint:
          <div className="kbd scrollbox" style={{ marginTop: 4 }}>
            {model.endpoint || "(not connected)"}
          </div>
        </div>
        {model.connected && (
          <div className="tiny" style={{ marginTop: 6 }}>
            {cardLoading ? (
              <span style={{ color: "var(--muted)" }}>Fetching agent card…</span>
            ) : card?.error ? (
              <span style={{ color: "var(--bad)" }}>Agent card error: {card.error}</span>
            ) : card ? (
              <span>
                Connected to <span className="kbd">{card.name || "A2A Endpoint"}</span>
                {card.description ? <> — {card.description}</> : null}
              </span>
            ) : null}
          </div>
        )}
        {model.error ? <div className="tiny" style={{ color: "var(--bad)", marginTop: 6 }}>Error: {model.error}</div> : null}
      </div>

      {/* Attachments */}
      <div className="panel attach">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <label>Attachments (planner sees summaries, keywords, last inspected)</label>
            <input type="file" multiple onChange={(e) => onAttachFiles(e.target.files)} />
          </div>
          <div className="tiny" style={{ color: "var(--muted)" }}>
            Toggle 🔒 to keep private (no analysis), ⭐ to prioritize.
          </div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <label className="tiny" style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={model.summarizeOnUpload}
              onChange={(e) => dispatch({ type: "toggleSummarizeOnUpload", on: e.target.checked })}
              style={{ verticalAlign: "middle", marginRight: 6 }}
            />
            Auto‑summarize attachments on upload
          </label>
          <div style={{ minWidth: 260, marginLeft: "auto" }}>
            <label>Attachment Summarizer Model</label>
            <select value={summarizerModel} onChange={(e) => setSummarizerModel(e.target.value)} className="w-full">
              {providers.map((p) => (
                <optgroup key={p.name} label={p.name}>
                  {(p.models || []).map((m) => (<option key={`${p.name}:${m}`} value={m}>{m}</option>))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
        <div className="attach-list-rows">
          {vaultRef.current.listBySource('local').map((att) => (
            <div className="attach-row" key={`${att.name}:${att.digest}`}>
              <div className="attach-row-left">
                <div className="attach-name">
                  <span className="badge">{att.name}</span>
                  <span className="tiny" style={{ marginLeft: 8, color: "var(--muted)" }}>
                    {att.mimeType} • {att.size.toLocaleString()} bytes
                  </span>
                </div>
                <div className="tiny" style={{ marginTop: 4 }}>
                  {att.last_inspected ? <>Last inspected: <span className="kbd">{att.last_inspected}</span></> : <span style={{ color: "var(--muted)" }}>Not summarized</span>}
                  {att.analysisPending ? <span style={{ marginLeft: 8 }}>• Analyzing…</span> : null}
                  {att.private ? <span style={{ marginLeft: 8 }}>• 🔒 Private</span> : null}
                  {att.priority ? <span style={{ marginLeft: 8 }}>• ⭐ High priority</span> : null}
                </div>
              </div>
              <div className="attach-row-actions">
                <button
                  className="ghost"
                  title="Toggle Private"
                  onClick={() => { vaultRef.current.updateFlags(att.name, { private: !att.private }); setFrontInput((x)=>x); }}
                >
                  {att.private ? "Unlock" : "Lock"}
                </button>
                <button
                  className="ghost"
                  title="Toggle Priority"
                  onClick={() => { vaultRef.current.updateFlags(att.name, { priority: !att.priority }); setFrontInput((x)=>x); }}
                >
                  {att.priority ? "Unstar" : "Star"}
                </button>
                <button
                  className="ghost"
                  onClick={() => summarizerRef.current?.queueAnalyze(att.name, { priority: true })}
                  disabled={att.private}
                  title={att.private ? "Private: analysis disabled" : "Analyze now"}
                >
                  Analyze now
                </button>
                <button
                  className="ghost"
                  onClick={() => { vaultRef.current.remove(att.name); setFrontInput((x)=>x); }}
                >
                  Remove
                </button>
              </div>
              <div className="attach-summary">
                <label className="tiny" style={{ display: "block", marginBottom: 4 }}>Summary (editable)</label>
                <textarea
                  rows={2}
                  value={att.summary || ""}
                  onChange={(e) => { vaultRef.current.updateSummary(att.name, e.target.value, att.keywords || []); setFrontInput((x)=>x); }}
                  placeholder={att.private ? "Private: no analysis performed" : "1–2 sentences about this file"}
                />
                <div className="tiny" style={{ marginTop: 6 }}>
                  Keywords:
                  <input
                    type="text"
                    style={{ marginLeft: 6, width: "60%" }}
                    value={(att.keywords || []).join(", ")}
                    onChange={(e) => {
                      const kw = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
                      vaultRef.current.updateSummary(att.name, att.summary || "", kw);
                      setFrontInput((x)=>x);
                    }}
                    placeholder="comma-separated (e.g., revenue, Q3, forecast)"
                  />
                </div>
              </div>
            </div>
          ))}
          {!vaultRef.current.listBySource('local').length ? (
            <div className="tiny" style={{ color: "var(--muted)" }}>
              No attachments yet. Upload files above; summaries will fill in automatically (unless private).
            </div>
          ) : null}
        </div>

        {/* Received from agent */}
        <div className="row" style={{ marginTop: 12 }}>
          <label>Received from agent</label>
        </div>
        <div className="attach-list-rows">
          {vaultRef.current.listBySource('agent').map((att) => (
            <div className="attach-row" key={`agent:${att.name}:${att.digest}`}>
              <div className="attach-row-left">
                <div className="attach-name">
                  <span className="badge">{att.name}</span>
                  <span className="tiny" style={{ marginLeft: 8, color: "var(--muted)" }}>
                    {att.mimeType} • {att.size.toLocaleString()} bytes • from agent
                  </span>
                </div>
                {att.summary ? (
                  <div className="tiny" style={{ marginTop: 4 }}>Summary: {att.summary}</div>
                ) : null}
              </div>
              <div className="attach-row-actions">
                <button
                  className="ghost"
                  onClick={() => openBase64Attachment(att.name, att.mimeType, att.bytes, undefined)}
                  title="Open in new tab"
                >
                  Open
                </button>
                <button className="ghost" onClick={() => { vaultRef.current.remove(att.name); setFrontInput((x)=>x); }}>Remove</button>
              </div>
            </div>
          ))}
          {!vaultRef.current.listBySource('agent').length ? (
            <div className="tiny" style={{ color: "var(--muted)" }}>
              No documents received from the agent yet.
            </div>
          ) : null}
        </div>
      </div>

      {/* Split view */}
      <div className="split2">
        {/* Front-stage */}
        <div className="panel chat">
          <div className="panel-title">User ↔ Planner</div>
          <div className="log" ref={frontLogRef}>
            {model.front.map((m) => (
              <div key={m.id} className={`bubble ${m.role === "you" ? "who-you" : m.role === "planner" ? "who-planner" : "who-sys"}`}>
                {m.text}
              </div>
            ))}
            {!model.front.length ? (
              <div className="tiny" style={{ textAlign: "center", color: "var(--muted)" }}>
                {model.plannerStarted ? 
                  "Paste background & goals above and/or write to the planner here." : 
                  "Click 'Begin' above to start the planner session."}
              </div>
            ) : null}
          </div>
          <div className="composer">
            <textarea
              rows={3}
              value={frontInput}
              onChange={(e) => setFrontInput(e.target.value)}
              disabled={!model.plannerStarted}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (model.connected && model.plannerStarted && frontInput.trim() && !model.busy) {
                    sendFrontMessage(frontInput);
                  }
                }
              }}
              placeholder={model.plannerStarted ? "Type to the planner… (constraints, preferences, confirmations)" : "Click 'Begin Planner' above to start"}
            />
            <div className="toolbar">
              <div className="tiny">
                Shortcuts: <span className="kbd">Enter</span> to send, <span className="kbd">Shift+Enter</span> for newline
              </div>
              <div className="row">
                <button onClick={() => setFrontInput("")} className="ghost">Clear</button>
                <button 
                  className="primary" 
                  disabled={!model.connected || !model.plannerStarted || !frontInput.trim() || model.busy} 
                  onClick={() => {
                    console.log("Send clicked. Connected:", model.connected, "Input:", frontInput, "Busy:", model.busy);
                    sendFrontMessage(frontInput);
                  }}
                  title={!model.connected ? "Not connected" : !model.plannerStarted ? "Start the planner" : !frontInput.trim() ? "Enter a message" : model.busy ? "System busy" : "Send message"}
                >Send</button>
              </div>
            </div>
            {!model.plannerStarted && (
              <div className="tiny" style={{ marginTop: 6, textAlign: 'center', color: 'var(--muted)' }}>
                Planner is not running. <button className="ghost" onClick={startPlanner} disabled={!model.connected}>Begin Planner</button>
              </div>
            )}
          </div>
        </div>

        {/* Agent channel */}
        <div className="panel chat">
          <div className="panel-title">Planner ↔ Agent (Task Transcript)</div>
          <div className="log" ref={agentLogRef}>
            {agentLog.map((m) => (
              <div key={m.id} className={`bubble ${m.role === "planner" ? "who-planner" : "who-them"} ${m.partial ? "partial" : ""}`}>
                {m.text}
                {m.attachments && m.attachments.length ? (
                  <div className="row" style={{ marginTop: 6, flexWrap: 'wrap', gap: 6 }}>
                    {m.attachments.map((a, idx) => (
                      <button
                        key={`${m.id}:att:${idx}`}
                        className="badge"
                        title={`${a.mimeType}`}
                        onClick={() => openBase64Attachment(a.name, a.mimeType, a.bytes, a.uri)}
                      >
                        <span style={{ marginRight: 6 }}>{fileIcon(a.mimeType)}</span>
                        {a.name}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            {!agentLog.length ? (
              <div className="tiny" style={{ textAlign: "center", color: "var(--muted)" }}>
                No agent transcript yet. The planner will send when ready (policy dependent).
              </div>
            ) : null}
          </div>
          <div className="tiny" style={{ textAlign: "center", color: "var(--muted)" }}>
            This view reflects the **actual** A2A task history (server echo + status partials).
          </div>
        </div>
      </div>

      {/* Footer removed */}
    </div>
  );
}
