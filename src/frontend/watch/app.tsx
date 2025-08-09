import React, { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { HashRouter as Router, Routes, Route, Link, useNavigate, useParams } from "react-router-dom";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { UnifiedEvent } from "$src/types/event.types";
import { WsEventStream } from "$src/agents/clients/event-stream";

dayjs.extend(relativeTime);

// Pull server URL from HTML-injected config if it exists, else default
declare const __API_BASE__: string | undefined;
const API_BASE: string =
  (typeof window !== "undefined" &&
    (window as any).__APP_CONFIG__?.API_BASE) ||
  (typeof __API_BASE__ !== "undefined" ? __API_BASE__ : "http://localhost:3000/api");

// Minimal one-shot WS JSON-RPC helper
async function wsRpcCall<T>(method: string, params?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const wsUrl = API_BASE.startsWith("http")
      ? API_BASE.replace(/^http/, "ws") + "/ws"
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_BASE}/ws`;

    const ws = new WebSocket(wsUrl);
    const id = crypto.randomUUID();

    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    };

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string);
      if (msg.id !== id) return;
      ws.close();
      if (msg.error) {
        reject(new Error(msg.error.message));
      } else {
        resolve(msg.result as T);
      }
    };

    ws.onerror = (err) => reject(err);
  });
}

// Color palette
const AGENT_COLORS = [
  "bg-blue-50",
  "bg-green-50",
  "bg-purple-50",
  "bg-pink-50",
  "bg-yellow-50",
  "bg-orange-50",
];
function colorForAgent(agentId?: string) {
  const id = agentId ?? "";
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const idx = Math.abs(hash) % AGENT_COLORS.length;
  return AGENT_COLORS[idx];
}

interface TurnView {
  turn: number;
  agentId?: string;
  startedAt: string;
  finality: string;
  messages: UnifiedEvent[];
  traces: UnifiedEvent[];
  systems: UnifiedEvent[];
}

type ConnState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

function useHealthPing(intervalMs = 8000) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: any;
    const tick = async () => {
      try {
        await wsRpcCall("ping");
        if (!cancelled) setOk(true);
      } catch {
        if (!cancelled) setOk(false);
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);
  return ok;
}

interface ConversationListProps {
  onSelect?: (id: number) => void;
  selectedId?: number | null;
  focusRef?: React.RefObject<HTMLDivElement>;
  requestFocusKey?: number; // bump to request focus
}

function ConversationList({ onSelect, selectedId = null, focusRef, requestFocusKey }: ConversationListProps) {
  const [hours, setHours] = useState(6);
  const [scenarioFilter, setScenarioFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [textFilter, setTextFilter] = useState("");
  const [conversations, setConversations] = useState<any[]>([]);
  const [scenarioMap, setScenarioMap] = useState<Record<string, any>>({});
  const [selectedIdx, setSelectedIdx] = useState<number>(-1);
  const containerRef = focusRef ?? useRef<HTMLDivElement>(null);
  const requestDetailFocusRef = useRef<() => void>();

  // helper to load list
  const loadList = async () => {
    const sinceIso = dayjs().subtract(hours, "hour").toISOString();
    const result = await wsRpcCall<{ conversations: any[] }>(
      "listConversations", {}
    );
    const recent = result.conversations.filter((c) =>
      dayjs(c.updatedAt).isAfter(sinceIso)
    );
    setConversations(recent);

    const scenarioIds = Array.from(
      new Set(recent.map((c: any) => c.scenarioId).filter(Boolean))
    );
    if (scenarioIds.length) {
      const scenarioMapLocal: Record<string, any> = {};
      for (const id of scenarioIds) {
        scenarioMapLocal[id] = { name: id, config: {} };
      }
      setScenarioMap(scenarioMapLocal);
    }
  };

  useEffect(() => {
    loadList().catch(console.error);
  }, [hours]);

  // subscribeAll to new convos
  useEffect(() => {
    const wsUrl = API_BASE.startsWith("http")
      ? API_BASE.replace(/^http/, "ws") + "/ws"
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_BASE}/ws`;
    const ws = new WebSocket(wsUrl);
    const id = crypto.randomUUID();

    ws.onopen = () => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "subscribeAll",
        params: { includeGuidance: false }
      }));
    };

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string);
      if (msg.method === "event" && msg.params?.type === "system") {
        if (msg.params?.payload?.kind === "meta_created") {
          loadList().catch(console.error);
        }
      }
    };

    ws.onerror = (err) => console.error("subscribeAll error", err);
    return () => ws.close();
  }, [hours]);

  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    Object.values(scenarioMap).forEach((sc: any) => {
      sc.config?.metadata?.tags?.forEach((t: string) => tags.add(t));
    });
    return Array.from(tags);
  }, [scenarioMap]);

  const filteredConvos = conversations.filter((c) => {
    if (scenarioFilter && c.scenarioId !== scenarioFilter) return false;
    if (tagFilter) {
      const tags =
        scenarioMap[c.scenarioId]?.config?.metadata?.tags || [];
      return tags.includes(tagFilter);
    }
    if (textFilter) {
      const hay = `${c.title || ""} ${c.scenarioId || ""} ${c.status || ""}`.toLowerCase();
      if (!hay.includes(textFilter.toLowerCase())) return false;
    }
    return true;
  });

  // keep selection in range and follow selectedId
  useEffect(() => {
    const idx = filteredConvos.findIndex((c) => c.conversation === selectedId);
    setSelectedIdx(idx);
  }, [selectedId, conversations.length, scenarioFilter, tagFilter, textFilter]);

  // keyboard navigation
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!filteredConvos.length) return;
    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min((i < 0 ? 0 : i) + 1, filteredConvos.length - 1));
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max((i < 0 ? 0 : i) - 1, 0));
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min((i < 0 ? 0 : i) + 10, filteredConvos.length - 1));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max((i < 0 ? 0 : i) - 10, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setSelectedIdx(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setSelectedIdx(filteredConvos.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = filteredConvos[Math.max(selectedIdx, 0)];
      if (row) onSelect?.(row.conversation);
    } else if (e.key === "/") {
      e.preventDefault();
      const input = containerRef.current?.querySelector<HTMLInputElement>("input[name=textFilter]");
      input?.focus();
      input?.select();
    } else if (e.key === "r" || (e.key === "R" && e.shiftKey)) {
      e.preventDefault();
      loadList().catch(console.error);
    } else if (e.key === "ArrowRight" || e.key === "l") {
      e.preventDefault();
      // ask parent to focus details
      requestDetailFocusRef.current?.();
    }
  };

  // request focus
  useEffect(() => {
    if (requestFocusKey && containerRef.current) {
      containerRef.current.focus();
    }
  }, [requestFocusKey]);

  // ensure selected row stays in view
  useEffect(() => {
    if (selectedIdx >= 0 && containerRef.current) {
      const row = containerRef.current.querySelector<HTMLElement>(`tr[data-row-index="${selectedIdx}"]`);
      row?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIdx]);

  return (
    <div
      className="p-4 space-y-4 outline-none h-full flex flex-col"
      ref={containerRef as any}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {/* filters */}
      <div className="flex flex-wrap gap-4 items-end">
        {/* hours */}
        <label className="flex flex-col text-sm">
          Hours back
          <input
            type="number"
            className="border p-1 w-20"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          />
        </label>
        {/* scenario */}
        <label className="flex flex-col text-sm">
          Scenario
          <select
            className="border p-1"
            value={scenarioFilter}
            onChange={(e) => setScenarioFilter(e.target.value)}
          >
            <option value="">(all)</option>
            {Object.entries(scenarioMap).map(([id, sc]) => (
              <option key={id} value={id}>
                {id} — {sc.name}
              </option>
            ))}
          </select>
        </label>
        {/* tag */}
        <label className="flex flex-col text-sm">
          Tag
          <select
            className="border p-1"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
          >
            <option value="">(all)</option>
            {availableTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {/* text filter */}
        <label className="flex flex-col text-sm flex-1 min-w-[200px]">
          Search
          <input
            name="textFilter"
            placeholder="/ title, scenario, status"
            className="border p-1"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
          />
        </label>
      </div>

      {/* table */}
      <div className="overflow-y-auto flex-1">
      <table className="w-full text-xs border">
        <thead className="bg-gray-100">
          <tr>
            <th className="p-1 text-left">ID</th>
            <th className="p-1">Title</th>
            <th className="p-1">Scenario</th>
            <th className="p-1">Tags</th>
            <th className="p-1">Status</th>
            <th className="p-1">Updated</th>
          </tr>
        </thead>
        <tbody>
          {filteredConvos.map((c, idx) => {
            const tags =
              scenarioMap[c.scenarioId]?.config?.metadata?.tags || [];
            const isSelected = selectedIdx >= 0 ? idx === selectedIdx : c.conversation === selectedId;
            return (
              <tr
                key={c.conversation}
                data-row-index={idx}
                className={`border-t hover:bg-gray-50 cursor-pointer ${isSelected ? "bg-blue-50" : ""}`}
                onClick={() => { setSelectedIdx(idx); onSelect?.(c.conversation); }}
              >
                <td className="p-1">{c.conversation}</td>
                <td className="p-1">
                  <span className="text-blue-600 hover:underline">
                    {c.title || "(untitled)"}
                  </span>
                </td>
                <td className="p-1">{c.scenarioId}</td>
                <td className="p-1">{tags.join(", ")}</td>
                <td className="p-1">{c.status}</td>
                <td className="p-1">{dayjs(c.updatedAt).fromNow()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

interface ConversationViewProps {
  id?: number | null;
  focusRef?: React.RefObject<HTMLDivElement>;
}

function ConversationView({ id, focusRef }: ConversationViewProps) {
  const [events, setEvents] = useState<UnifiedEvent[]>([]);
  const [showTraces, setShowTraces] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [meta, setMeta] = useState<any>(null);
  const [connState, setConnState] = useState<ConnState>("idle");

  const seenSeqRef = useRef<Set<number>>(new Set());
  const wsRef = useRef<WsEventStream | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = focusRef ?? useRef<HTMLDivElement>(null);

  const fetchHistory = async () => {
    if (!id) return;
    try {
      const data = await wsRpcCall<any>("getConversation", {
        conversationId: Number(id),
      });
      setMeta(data);
      if (data.events) {
        const unique = data.events.filter((e: UnifiedEvent) => {
          if (seenSeqRef.current.has(e.seq)) return false;
          seenSeqRef.current.add(e.seq);
          return true;
        });
        setEvents((prev) => [...prev, ...unique].sort((a, b) => a.seq - b.seq));
      }
    } catch (err) {
      console.error("Error loading conversation:", err);
    }
  };

  const connectWS = () => {
    if (!id) return;
    setConnState((s) => (s === "idle" ? "connecting" : "reconnecting"));
    const wsUrl = API_BASE.startsWith("http")
      ? API_BASE.replace(/^http/, "ws") + "/ws"
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_BASE}/ws`;
    const lastSeq = events.length ? events[events.length - 1]?.seq : undefined;
    const s = new WsEventStream(wsUrl, {
      conversationId: Number(id),
      includeGuidance: true,
      reconnectDelayMs: 1500,
      ...(typeof lastSeq === 'number' ? { sinceSeq: lastSeq } : {}),
    });
    s.onStateChange = (st) => setConnState(st as ConnState);
    wsRef.current = s;
    (async () => {
      try {
        for await (const ev of s) {
          // Ignore transient guidance events for the timeline
          if ((ev as any).type === 'guidance') {
            continue;
          }
          const ue = ev as UnifiedEvent;
          if (seenSeqRef.current.has(ue.seq)) continue;
          seenSeqRef.current.add(ue.seq);
          setEvents((prev) => [...prev, ue].sort((a, b) => a.seq - b.seq));
        }
      } catch (err) {
        console.warn("WS stream error", err);
      } finally {
        // Stream was closed intentionally; avoid auto-reconnect loops here.
      }
    })();
  };

  useEffect(() => {
    seenSeqRef.current.clear();
    setEvents([]);
    setConnState("idle");
    fetchHistory().then(connectWS);
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
      setConnState("closed");
    };
  }, [id]);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [events, autoScroll]);

   // keyboard controls for detail pane
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!id) return;
    if (e.key === "t") {
      e.preventDefault();
      setShowTraces((v) => !v);
    } else if (e.key === "a") {
      e.preventDefault();
      setAutoScroll((v) => !v);
    } else if (e.key === "r") {
      e.preventDefault();
      // manual reconnect + refresh
      wsRef.current?.close();
      setConnState("reconnecting");
      fetchHistory().then(connectWS);
    } else if (e.key === "ArrowLeft" || e.key === "h") {
      e.preventDefault();
      // focus list pane by dispatching a custom event
      window.dispatchEvent(new CustomEvent("watch:focus:list"));
    }
  };

  const turns = useMemo(() => {
    const byTurn: Record<number, TurnView> = {};
    for (const e of events) {
      if (!byTurn[e.turn]) {
        byTurn[e.turn] = {
          turn: e.turn,
          agentId: e.agentId,
          startedAt: e.ts,
          finality: e.finality,
          messages: [],
          traces: [],
          systems: [],
        };
      }
      if (e.type === "message") byTurn[e.turn]?.messages.push(e);
      else if (e.type === "trace") byTurn[e.turn]?.traces.push(e);
      else if (e.type === "system") byTurn[e.turn]?.systems.push(e);
    }
    return Object.values(byTurn).sort((a, b) => a.turn - b.turn);
  }, [events]);

  return (
    <div
      className="p-4 flex flex-col h-full outline-none"
      ref={containerRef as any}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm text-gray-600">
          {meta && (
            <>
              <span className="mr-3"><strong>Scenario:</strong> {meta.scenarioId}</span>
              {meta.metadata?.tags && (
                <span><strong>Tags:</strong> {meta.metadata.tags.join(", ")}</span>
              )}
            </>
          )}
        </div>
        <ConnBadge state={connState} />
      </div>
      {meta && (
        <div className="mb-2 text-xs text-gray-500">Conversation #{id}</div>
      )}
      <div className="flex gap-4 mb-4 text-sm">
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" checked={showTraces} onChange={(e) => setShowTraces(e.target.checked)} /> Show Traces
        </label>
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> Auto‑scroll
        </label>
      </div>
      <div className="flex-1 overflow-y-auto space-y-4">
        {turns.map((t, i) => {
          const colorClass = colorForAgent(t.agentId);
          return (
            <div key={`turn-${typeof t.turn === 'number' ? t.turn : i}`} className={`border rounded-lg p-2 ${colorClass}`}>
              <div className="flex justify-between text-xs font-semibold mb-1">
                <span>Turn {t.turn} — {t.agentId || 'system'}</span>
                <span>{dayjs(t.startedAt).format("HH:mm:ss")}</span>
              </div>
              {t.messages.map((m) => (
                <div key={m.seq} className="bg-white rounded px-3 py-1 mb-1 shadow-sm">
                  <div className="text-gray-500 text-[0.7rem]">{m.type}/{m.finality}</div>
                  <div className="whitespace-pre-wrap font-sans text-sm">
                    {(m.payload as any).text || JSON.stringify(m.payload)}
                  </div>
                </div>
              ))}
              {showTraces && t.traces.length > 0 && (
                <details className="mt-2">
                  <summary className="text-xs text-gray-700 cursor-pointer">
                    {t.traces.length} trace events
                  </summary>
                  <div className="mt-1 space-y-1">
                    {t.traces.map((tr) => (
                      <div key={tr.seq} className="bg-yellow-50 p-1 rounded text-xs font-mono break-words">
                        {JSON.stringify(tr.payload)}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function ConnBadge({ state }: { state: ConnState }) {
  const color =
    state === "open" ? "bg-green-500" : state === "reconnecting" || state === "connecting" ? "bg-yellow-500" : "bg-gray-400";
  const label = state === "open" ? "live" : state === "connecting" ? "connecting" : state === "reconnecting" ? "reconnecting" : state === "closed" ? "closed" : "idle";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      <span className="text-gray-600">{label}</span>
    </div>
  );
}

function useLocalStorageNumber(key: string, initial: number) {
  const [val, setVal] = useState<number>(() => {
    const raw = localStorage.getItem(key);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : initial;
  });
  useEffect(() => {
    localStorage.setItem(key, String(val));
  }, [key, val]);
  return [val, setVal] as const;
}

function SplitLayout() {
  const health = useHealthPing();
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const selectedId = params.id ? Number(params.id) : null;

  const [leftWidth, setLeftWidth] = useLocalStorageNumber("watch.leftWidth", 360);
  const [dragging, setDragging] = useState(false);
  const [listFocusKey, setListFocusKey] = useState(0);
  const [detailFocusKey, setDetailFocusKey] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const onSelect = useCallback((id: number) => {
    navigate(`/conversation/${id}`);
  }, [navigate]);

  // drag logic
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      setLeftWidth(Math.max(240, Math.min(window.innerWidth - 320, e.clientX)));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // global keybindings: h/l to move focus, ? help modal toggle
  const [showHelp, setShowHelp] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setShowHelp((v) => !v);
      } else if (e.key === "h") {
        e.preventDefault();
        setListFocusKey((k) => k + 1);
      } else if (e.key === "l") {
        e.preventDefault();
        setDetailFocusKey((k) => k + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setListFocusKey((k) => k + 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setDetailFocusKey((k) => k + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // initial focus on list
  useEffect(() => {
    setListFocusKey((k) => k + 1);
  }, []);

  // listen for detail pane requesting focus shift to list
  useEffect(() => {
    const onEvt = () => setListFocusKey((k) => k + 1);
    window.addEventListener("watch:focus:list", onEvt as any);
    return () => window.removeEventListener("watch:focus:list", onEvt as any);
  }, []);

  return (
    <div className="font-sans text-gray-900 bg-gray-50 h-screen overflow-hidden flex flex-col">
      <header className="flex items-center justify-between px-3 py-2 border-b bg-white">
        <div className="font-semibold">Watch</div>
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2 text-gray-600">
            <span className={`inline-block w-2 h-2 rounded-full ${health ? "bg-green-500" : health === false ? "bg-red-500" : "bg-gray-400"}`} />
            <span>{health ? "API OK" : health === false ? "API down" : "checking"}</span>
          </div>
          <div className="text-gray-500">Shortcuts: ?</div>
        </div>
      </header>
      <div className="flex-1 flex min-h-0">
        <div className="border-r bg-white min-w-[240px] flex flex-col min-h-0 overflow-hidden" style={{ width: leftWidth }}>
          <ConversationList onSelect={onSelect} selectedId={selectedId ?? null} focusRef={listRef} requestFocusKey={listFocusKey} />
        </div>
        <div
          className={`w-1 bg-gray-200 cursor-col-resize ${dragging ? "bg-blue-400" : ""}`}
          onMouseDown={() => setDragging(true)}
          title="Drag to resize"
        />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {selectedId ? (
            <ConversationView id={selectedId} focusRef={detailRef} />
          ) : (
            <div className="h-full flex items-center justify-center text-gray-400 text-sm">
              Select a conversation from the left
            </div>
          )}
        </div>
      </div>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}

function HelpModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded shadow-lg p-4 w-[680px] max-w-[95vw]">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold">Keyboard Shortcuts</div>
          <button className="text-sm text-gray-500 hover:text-gray-800" onClick={onClose}>Close (Esc)</button>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Shortcut label="j / k" desc="Move selection down / up (list)" />
          <Shortcut label="Enter" desc="Open selected conversation" />
          <Shortcut label="/" desc="Focus list search" />
          <Shortcut label="h / l, ← / →" desc="Focus list / details" />
          <Shortcut label="PgUp / PgDn" desc="Jump selection by 10 (list)" />
          <Shortcut label="Home / End" desc="Jump to start / end (list)" />
          <Shortcut label="r" desc="Refresh list / reconnect details" />
          <Shortcut label="t" desc="Toggle traces (details)" />
          <Shortcut label="a" desc="Toggle autoscroll (details)" />
          <Shortcut label="?" desc="Toggle this help" />
        </div>
      </div>
    </div>
  );
}

function Shortcut({ label, desc }: { label: string; desc: string }) {
  return (
    <div className="flex items-center justify-between border rounded px-2 py-1">
      <span className="font-mono text-xs bg-gray-100 rounded px-1 py-0.5">{label}</span>
      <span className="text-xs text-gray-600">{desc}</span>
    </div>
  );
}

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<SplitLayout />} />
        <Route path="/conversation/:id" element={<SplitLayout />} />
      </Routes>
    </Router>
  );
}

// Mount the app
import ReactDOM from "react-dom/client";
const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<App />);
