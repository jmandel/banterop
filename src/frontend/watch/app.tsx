import React, { useEffect, useState, useMemo, useRef } from "react";
import {
  HashRouter as Router,
  Routes,
  Route,
  Link,
  useParams,
} from "react-router-dom";
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
function colorForAgent(agentId: string) {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = agentId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const idx = Math.abs(hash) % AGENT_COLORS.length;
  return AGENT_COLORS[idx];
}

interface TurnView {
  turn: number;
  agentId: string;
  startedAt: string;
  finality: string;
  messages: UnifiedEvent[];
  traces: UnifiedEvent[];
  systems: UnifiedEvent[];
}

function ConversationList() {
  const [hours, setHours] = useState(6);
  const [scenarioFilter, setScenarioFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [conversations, setConversations] = useState<any[]>([]);
  const [scenarioMap, setScenarioMap] = useState<Record<string, any>>({});

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
    return true;
  });

  return (
    <div className="p-4 space-y-4">
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
      </div>

      {/* table */}
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
          {filteredConvos.map((c) => {
            const tags =
              scenarioMap[c.scenarioId]?.config?.metadata?.tags || [];
            return (
              <tr key={c.conversation} className="border-t hover:bg-gray-50">
                <td className="p-1">{c.conversation}</td>
                <td className="p-1">
                  <Link
                    className="text-blue-600 hover:underline"
                    to={`/conversation/${c.conversation}`}
                  >
                    {c.title || "(untitled)"}
                  </Link>
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
  );
}

function ConversationView() {
  const { id } = useParams<{ id: string }>();
  const [events, setEvents] = useState<UnifiedEvent[]>([]);
  const [showTraces, setShowTraces] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [meta, setMeta] = useState<any>(null);

  const seenSeqRef = useRef<Set<number>>(new Set());
  const wsRef = useRef<WsEventStream | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

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
    const wsUrl = API_BASE.startsWith("http")
      ? API_BASE.replace(/^http/, "ws") + "/ws"
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_BASE}/ws`;
    const s = new WsEventStream(wsUrl, {
      conversationId: Number(id),
      includeGuidance: true,
    });
    wsRef.current = s;
    (async () => {
      try {
        for await (const ev of s) {
          const ue = ev as UnifiedEvent;
          if (seenSeqRef.current.has(ue.seq)) continue;
          seenSeqRef.current.add(ue.seq);
          setEvents((prev) => [...prev, ue].sort((a, b) => a.seq - b.seq));
        }
      } catch (err) {
        console.warn("WS stream error", err);
      } finally {
        setTimeout(() => {
          console.log("Reconnecting WS...");
          fetchHistory().then(connectWS);
        }, 2000);
      }
    })();
  };

  useEffect(() => {
    seenSeqRef.current.clear();
    setEvents([]);
    fetchHistory().then(connectWS);
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [events, autoScroll]);

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
    <div className="p-4 flex flex-col h-full">
      <Link to="/" className="text-sm text-blue-600 hover:underline mb-2">
        ← Back to list
      </Link>
      {meta && (
        <div className="mb-4 text-sm text-gray-600">
          <div><strong>Scenario:</strong> {meta.scenarioId}</div>
          {meta.metadata?.tags && (
            <div><strong>Tags:</strong> {meta.metadata.tags.join(", ")}</div>
          )}
        </div>
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
        {turns.map((t) => {
          const colorClass = colorForAgent(t.agentId);
          return (
            <div key={t.turn} className={`border rounded-lg p-2 ${colorClass}`}>
              <div className="flex justify-between text-xs font-semibold mb-1">
                <span>Turn {t.turn} — {t.agentId}</span>
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

function App() {
  return (
    <Router>
      <div className="font-sans text-gray-900 bg-gray-50 min-h-screen">
        <Routes>
          <Route path="/" element={<ConversationList />} />
          <Route path="/conversation/:id" element={<ConversationView />} />
        </Routes>
      </div>
    </Router>
  );
}

// Mount the app
import ReactDOM from "react-dom/client";
const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<App />);
