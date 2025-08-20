import React, { useEffect, useReducer, useRef, useState } from "react";
import { AppLayout } from "../ui";
import type { A2AStatus } from "./a2a-types";
import { DualConversationView } from "./components/Conversations/DualConversationView";
import type { UnifiedEvent as PlannerUnifiedEvent } from "./types/events";
import { selectFrontMessages, selectAgentLog, selectLastStatus } from "./selectors/transcripts";
import { EventLogView } from "./components/EventLogView";
import { StepFlow } from "./components/StepFlow/StepFlow";
import { detectProtocolFromUrl, type Protocol } from "./protocols";
import { API_BASE } from './api-base';
import { useDebounce } from "./useDebounce";
import { useAppStore, getAttachmentVaultForUI } from "./stores/appStore";
import "./stores/init";

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
  // Endpoint/protocol now come from the store via ConnectionStep/StepFlow
  const [resumeTask, setResumeTask] = useState("");
  const [providers, setProviders] = useState<Array<{ name: string; models: string[] }>>([]);
  const [plannerThinking, setPlannerThinking] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    try { return useAppStore.getState().planner.model || ""; } catch { return ""; }
  });

  const app = useAppStore();

  // Removed auto/initial connect; use Connect button in Step 1

  // Legacy refs removed; SessionManager owns client, task, planner, and summarizer
  const selectedModelRef = useRef<string>(selectedModel);
  // Planner mode kept in local UI state only
  const plannerStartedRef = useRef<boolean>(false);
  // no-op placeholders removed; unified event log drives UI
  // Scenario URL + agent selection handled in store via ConfigurationStep

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

  // No local endpoint/scenarioUrl; handled by stores/components
  const card = useAppStore(s => s.connection.card);
  const cardLoading = false;
  const eventLog = useAppStore(s => s.planner.eventLog) as PlannerUnifiedEvent[];
  const preloadedEventsRef = useRef<PlannerUnifiedEvent[] | null>(null);
  // SessionManager persists event log snapshots
  // Derive transcripts and status from unified Event Log
  const derivedFront = React.useMemo(() => selectFrontMessages(eventLog as any), [eventLog]);
  const derivedAgent = React.useMemo(() => selectAgentLog(eventLog as any), [eventLog]);
  const lastStatusStr = React.useMemo(() => selectLastStatus(eventLog as any), [eventLog]);
  const yourTurn = lastStatusStr ? lastStatusStr === 'input-required' : true; // allow initial send pre-status

  // Event log persistence handled by SessionManager

  // Event queue with monotonic counter to avoid missed wakeups
  // Planner wake queue removed; SessionManager orchestrates ticks
  
  // Front-stage composer
  const [frontInput, setFrontInput] = useState("");
  const [attachmentUpdateTrigger, setAttachmentUpdateTrigger] = useState(0);
  // Front draft persistence removed for simplicity

  // Persistence handled by StorageService/Config pipeline

  // If endpoint is cleared, reset protocol selector to Auto to avoid misleading MCP/A2A state
  // Protocol auto-reset handled by preview logic

  // On initial load, if endpoint includes explicit /a2a or /mcp but UI isn't Auto,
  // force selector to Auto to avoid mismatched requests. Honor explicit prefill.
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
  }, []);

  // Instructions are managed in-session by ConfigurationStep
  // No longer persisting background/goals by default
  useEffect(() => { try { localStorage.setItem("a2a.planner.model", selectedModel); } catch {} }, [selectedModel]);
  
  // No more plannerMode/summarizeOnUpload in local reducer; store owns preferences
  // Scenario URL persistence handled by init subscription
  

  // Removed beforeunload persistence (SessionManager manages snapshots)

  // Helper: per-URL key builders
  // Keys now handled by SessionManager/StorageService

  // Selection restoration handled in SessionManager

  // Removed per-task draft persistence

  // No auto-connect; manual via Step 1 Connect button

  // Removed auto-detect protocol effect to avoid race conditions; resolution happens in handleConnect

  // Provider list fetched in ConfigurationStep

  // Keep planner model ref in sync (used by summarizer as well)
  useEffect(() => { selectedModelRef.current = selectedModel; try { app.actions.setModel(selectedModel); } catch {} }, [selectedModel]);

  // Planner thinking indicator from store
  const storePlannerThinking = useAppStore(s => s.planner.thinking);
  useEffect(() => { setPlannerThinking(!!storePlannerThinking); }, [storePlannerThinking]);

  // Prefill agent selections moved to SessionManager

  const handleConnect = async (endpointUrl: string, proto: Protocol) => {
    console.debug('[App] handleConnect: start', { endpointUrl, proto });
    try {
      await app.actions.connect(endpointUrl, proto);
      await app.actions.resumeTask(resumeTask.trim() || undefined);
    } catch (e: any) {
      console.warn('[App] handleConnect: error', e);
    } finally {
      console.debug('[App] handleConnect: done');
    }
  };

  const startPlanner = () => { try { app.actions.startPlanner(); } catch {} };

  const stopPlanner = () => { try { app.actions.stopPlanner(); } catch {} };

  const cancelTask = async (opts?: { reconnect?: boolean }) => {
    const epNow = useAppStore.getState().connection.endpoint;
    const protoNow = useAppStore.getState().connection.protocol;
    console.debug('[App] cancelTask: begin', { endpoint: epNow, protocol: protoNow, reconnect: !!opts?.reconnect });
    try { await app.actions.cancelTask(); } catch (e) { console.warn('[App] cancelTask: cancel error', e); }
    preloadedEventsRef.current = null;
    setFrontInput("");
    setResumeTask("");
    console.debug('[App] cancelTask: cleared UI state');
    if (opts?.reconnect) {
      const ep = (epNow || '').trim();
      if (ep) {
        console.debug('[App] cancelTask: reconnecting', { ep, protocol: protoNow });
        try { await handleConnect(ep, protoNow); } catch (e) { console.warn('[App] cancelTask: reconnect error', e); }
      }
    }
    try {
      const scen = useAppStore.getState().scenario.url;
      if (scen && scen.trim()) { console.debug('[App] cancelTask: reload scenario'); await onLoadScenarioUrl(); }
    } catch {}
    console.debug('[App] cancelTask: done');
  };

  // UI handler for the Reset button: clear + immediate reconnect for a fresh planner
  const onResetClient = () => { void cancelTask({ reconnect: true }); };

  const sendFrontMessage = async (text: string) => {
    if (!text.trim()) return;
    try { await app.actions.sendMessage([{ kind: 'text', text }]); } catch {}
    setFrontInput("");
  };

  // Scenario URL loader and agent selection
  const onLoadScenarioUrl = async () => {};

  // Planner agent selection handled in ConfigurationStep via SessionManager

  // Tool persistence handled in SessionManager

  // Auto-load scenario when URL is present/changes (via SessionManager)
  // Scenario changes handled by ConfigurationStep

  // Ensure scenario is (re)fetched after connect/reset when a URL is present
  const storeConnected = useAppStore(s => s.connection.status === 'connected');
  // Ensure scenario is fetched when connected handled by store

  

  // Tools derived from session in ConfigurationStep

  // Tool toggles handled in ConfigurationStep via SessionManager
const onAttachFiles = async (files: FileList | null) => {
    await app.actions.uploadFiles(files);
    setAttachmentUpdateTrigger(prev => prev + 1);
  };

  const onAnalyzeAttachment = (name: string) => { app.actions.analyzeAttachment(name); };

  const openBase64Attachment = (name: string, _mimeType: string, _bytes?: string, _uri?: string) => {
    // Defer to session-managed vault; avoids duplicating logic
    void app.actions.openAttachment(name);
  };
  
  // Deprecated: external scenario detector is no longer used to populate instructions

  return (
    <AppLayout title="Conversational Client">
      <div className="w-full">
          
          {/* Main Step Flow Section */}
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 mb-8">
          <StepFlow />
          </div>

          {/* Conversations Section */}
          <DualConversationView />

          {/* Event Log Section */}
          <div className="mt-8">
            <EventLogView events={eventLog} busy={plannerThinking} />
          </div>
      </div>
    </AppLayout>
  );
}
