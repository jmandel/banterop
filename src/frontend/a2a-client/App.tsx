import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppLayout } from "../ui";
import type { A2AStatus } from "./a2a-types";
import { A2AClient } from "./a2a-client";
import { AttachmentVault } from "./attachments-vault";
import { Planner } from "./planner";
import { ServerLLMProvider } from "./llm-provider";
import { A2ATaskClient } from "./a2a-task-client";
import { AttachmentSummarizer } from "./attachment-summaries";
import { useDebounce } from "./useDebounce";
import { StepFlow } from "./components/StepFlow/StepFlowNoCollapse";
import { DualConversationView } from "./components/Conversations/DualConversationView";
import { AttachmentBar } from "./components/Attachments/AttachmentBar";

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
  const debouncedEndpoint = useDebounce(endpoint, 500);
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
  
  const ptSendInFlight = useRef(false);
  const ptStreamAbort = useRef<AbortController | null>(null);
  const lastStatusRef = useRef<A2AStatus | "initializing">("initializing");
  const lastTaskIdRef = useRef<string | undefined>(undefined);

  // Front-stage composer
  const [frontInput, setFrontInput] = useState("");
  const [attachmentUpdateTrigger, setAttachmentUpdateTrigger] = useState(0);

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

  // Auto-connect when debounced endpoint changes
  useEffect(() => {
    if (debouncedEndpoint !== model.endpoint || !model.connected) {
      console.log("[App] Auto-connecting to:", debouncedEndpoint);
      handleConnect(debouncedEndpoint);
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

  const handleConnect = async (endpointUrl: string) => {
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

    const taskClient = new A2ATaskClient(endpointUrl);
    taskRef.current = taskClient;

    // Attachment summarizer (background)
    summarizerRef.current = new AttachmentSummarizer(() => summarizerModelRef.current || undefined, vaultRef.current);
    summarizerRef.current.onUpdate((name) => {
      signalEvent('summarizer');
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
      signalEvent('store');
    });
    taskClient.on('new-task', () => {
      const st = taskRef.current?.getStatus();
      if (st && lastStatusRef.current !== st) {
        lastStatusRef.current = st;
        dispatch({ type: 'status', status: st });
        if (st === 'input-required') dispatch({ type: 'system', text: '— your turn now —' });
        if (st === 'completed') {
          dispatch({ type: 'system', text: '— conversation completed —' });
          // Stop the planner when task is completed
          plannerRef.current?.stop();
          plannerRef.current = null;
          dispatch({ type: 'setPlannerStarted', started: false });
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
          plannerRef.current?.stop();
          plannerRef.current = null;
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
          plannerRef.current?.stop();
          plannerRef.current = null;
          dispatch({ type: 'setPlannerStarted', started: false });
          // Abort any active streams
          try {
            ptStreamAbort.current?.abort();
            ptStreamAbort.current = null;
          } catch {}
          ptSendInFlight.current = false;
        }
      }
    });

    // Fetch agent card
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
            const d: string = skill.description as string;
            const msg = hasTask
              ? d.replace(/^Open a conversation with/i, 'Calling send_to_agent will continue the conversation with')
              : d.replace(/^Open a conversation with/i, 'Calling send_to_agent will begin a new conversation with');
            return msg;
          }
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

  const stopPlanner = () => {
    plannerRef.current?.stop();
    plannerRef.current = null;
    dispatch({ type: 'setPlannerStarted', started: false });
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

  const sendFrontMessage = async (text: string) => {
    if (!text.trim()) return;
    console.log("Sending front message:", text);
    dispatch({ type: "frontAppend", msg: { id: crypto.randomUUID(), role: "you", text } });
    try { plannerRef.current?.recordUserReply?.(text); } catch {}
    setFrontInput("");
    
    // In passthrough mode, proactively send
    if (
      plannerModeRef.current === "passthrough" &&
      plannerRef.current &&
      clientRef.current &&
      taskRef.current &&
      (!ptSendInFlight.current || !!taskRef.current.getTaskId())
    ) {
      const parts = [{ kind: "text", text } as const];
      const taskId = taskRef.current.getTaskId();
      if (!taskId) {
        ptSendInFlight.current = true;
        (async () => {
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
  
  const handleLoadScenario = (goals: string, instructions: string) => {
    setGoals(goals);
    setInstructions(instructions);
    dispatch({ type: 'system', text: '✓ Scenario configuration loaded successfully' });
  };

  return (
    <AppLayout title="A2A Client">
      <div className="w-full">
          
          {/* Main Step Flow Section */}
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 mb-8">
            <StepFlow
              // Connection props
              endpoint={endpoint}
              onEndpointChange={setEndpoint}
              status={model.status}
              taskId={model.taskId}
              connected={model.connected}
              error={model.error}
              card={card}
              cardLoading={cardLoading}
              onCancelTask={cancelTask}
              
              // Configuration props
              goals={goals}
              onGoalsChange={setGoals}
              instructions={instructions}
              onInstructionsChange={setInstructions}
              plannerMode={model.plannerMode}
              onPlannerModeChange={(mode) => dispatch({ type: "setPlannerMode", mode })}
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
              providers={providers}
              plannerStarted={model.plannerStarted}
              onStartPlanner={startPlanner}
              onStopPlanner={stopPlanner}
              onLoadScenario={handleLoadScenario}
            />
          </div>

          {/* Attachments Section */}
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6 mb-6">
            <AttachmentBar
              vault={vaultRef.current}
              onFilesSelect={onAttachFiles}
              onAnalyze={onAnalyzeAttachment}
              onOpenAttachment={openBase64Attachment}
              summarizeOnUpload={model.summarizeOnUpload}
              onToggleSummarize={(on) => dispatch({ type: "toggleSummarizeOnUpload", on })}
              summarizerModel={summarizerModel}
              onSummarizerModelChange={setSummarizerModel}
              providers={providers}
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
            />
      </div>
    </AppLayout>
  );
}