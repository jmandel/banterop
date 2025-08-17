import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui';
import { useParams } from 'react-router-dom';
import { BrowserAgentRegistry } from '$src/agents/clients/browser-agent-registry';
import { BrowserAgentHost } from '$src/agents/clients/browser-agent-host';
import { BrowserAgentLifecycleManager } from '$src/agents/clients/browser-agent-lifecycle';
import { WsControl } from '$src/control/ws.control';
import type { UnifiedEvent } from '$src/types/event.types';

declare const __API_BASE__: string | undefined;
const API_BASE: string =
  (typeof window !== 'undefined' && (window as any).__APP_CONFIG__?.API_BASE) ||
  (typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : 'http://localhost:3000/api');

function decodeConfigFromBase64URL(s: string) {
  const json = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(json);
}

async function wsRpcCall<T>(method: string, params?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    const id = crypto.randomUUID();
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    ws.onmessage = (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id !== id) return;
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result as T);
    };
    ws.onerror = (e) => reject(e);
  });
}

export function ScenarioConfiguredPage() {
  const { config64, conversationId: conversationIdParam } = useParams<{ config64?: string; conversationId?: string }>();
  const [config, setConfig] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [actionMsg, setActionMsg] = useState<string>('');
  const [startingByAgent, setStartingByAgent] = useState<Record<string, boolean>>({});
  const [serverRunning, setServerRunning] = useState<Record<string, boolean>>({});
  const [browserRunning, setBrowserRunning] = useState<Record<string, boolean>>({});
  const [canceling, setCanceling] = useState<boolean>(false);

  // Inline thread state
  const [messages, setMessages] = useState<UnifiedEvent[]>([]);
  const [convSnap, setConvSnap] = useState<any | null>(null);
  const [isCompleted, setIsCompleted] = useState<boolean>(false);
  const [finalStatus, setFinalStatus] = useState<'completed'|'canceled'|'errored'|''>('');
  const [finalReason, setFinalReason] = useState<string>('');
  const eventWsRef = useRef<WebSocket | null>(null);
  const startingRef = useRef<boolean>(false);
  const managerRef = useRef<BrowserAgentLifecycleManager | null>(null);
  const serverControlRef = useRef<WsControl | null>(null);
  const resumedRef = useRef<boolean>(false);
  const [resumed, setResumed] = useState<boolean>(false);

  useEffect(() => {
    // If we have a conversationId in the route, use it directly
    if (conversationIdParam) {
      const idNum = Number(conversationIdParam);
      if (!Number.isNaN(idNum)) setConversationId(idNum);
    }
    // If config64 provided, decode and keep for a manual Start action later
    if (config64) {
      try { setConfig(decodeConfigFromBase64URL(config64)); }
      catch (e: any) { setError(e?.message || 'Invalid configuration'); }
    }
  }, [config64, conversationIdParam]);

  async function startConversationNow() {
    if (!config) return;
    try {
      setIsCreating(true);
      const res = await wsRpcCall<{ conversationId: number }>('createConversation', config);
      setConversationId(res.conversationId);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setIsCreating(false);
    }
  }

  // Subscribe to events for inline thread
  useEffect(() => {
    if (!conversationId) return;
    // Close any existing
    if (eventWsRef.current) {
      try { eventWsRef.current.close(); } catch {}
      eventWsRef.current = null;
    }
    setMessages([]);

    const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    eventWsRef.current = ws;
    const subId = `sub-${conversationId}`;
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: subId, method: 'subscribe', params: { conversationId, sinceSeq: 0 } }));
      // Also fetch a one-shot snapshot (with scenario/meta) for UI details and breadcrumbs
      wsRpcCall<any>('getConversation', { conversationId, includeScenario: true }).then((snap) => {
        setConvSnap(snap);
        setIsCompleted(snap?.status === 'completed');
        const msgs: UnifiedEvent[] = (snap.events || []).filter((e: UnifiedEvent) => e.type === 'message');
        setMessages(msgs);
        if (snap?.status === 'completed') {
          // Try to derive terminal reason from the last conversation-final message
          const lastMsg = [...msgs].reverse().find((m: any) => m.finality === 'conversation');
          if (lastMsg) {
            const payload = (lastMsg as any).payload || {};
            const outcome = payload.outcome || {};
            const status = outcome.status || 'completed';
            const reason = outcome.reason || payload.text || '';
            setFinalStatus(status as any);
            setFinalReason(String(reason || '').trim());
          }
        }
        try {
          const meta = snap?.metadata || {};
          const store = {
            scenarioId: meta?.scenarioId,
            title: meta?.title,
          };
          localStorage.setItem(`convoMeta:${conversationId}`, JSON.stringify(store));
        } catch {}
      }).catch(() => {});
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(String(evt.data));
        // Ignore subscription ack
        if (msg.id === subId) return;
        let ev: UnifiedEvent | null = null;
        if (msg.method === 'event' && msg.params) ev = msg.params as UnifiedEvent;
        else if (msg.type && msg.conversation === conversationId) ev = msg as UnifiedEvent;
        if (ev && ev.type === 'message') {
          setMessages((prev) => {
            if (prev.some((p) => p.seq === ev!.seq)) return prev;
            const next = [...prev, ev!].sort((a, b) => a.seq - b.seq);
            return next;
          });
          // Handle conversation completion
          if ((ev as any).finality === 'conversation') {
            setIsCompleted(true);
            // Capture reason from this closing event
            try {
              const payload = (ev as any).payload || {};
              const outcome = payload.outcome || {};
              const status = outcome.status || 'unknown';
              const reason = outcome.reason || '';
              setFinalStatus(status as any);
              setFinalReason(String(reason || '').trim());
            } catch {}
            // Proactively stop local browser agents and clear UI state
            if (managerRef.current && conversationId) {
              managerRef.current.stop(conversationId).catch(() => {});
            }
            setBrowserRunning({});
            setServerRunning({});
          }
        }
      } catch (e) {
        console.error('[Configured] WS parse error', e);
      }
    };
    ws.onclose = () => { eventWsRef.current = null; };
    return () => { try { ws.close(); } catch {} };
  }, [conversationId]);

  // Helpers for agent control
  const listAgentIds = (): string[] => {
    const fromConfig = (config?.meta?.agents || []).map((a: any) => a.id);
    if (fromConfig.length) return fromConfig;
    const fromSnap = (convSnap?.metadata?.agents || []).map((a: any) => a.id);
    return fromSnap;
  };
  // Ensure browser manager exists and resume local agents once on load
  useEffect(() => {
    if (managerRef.current) return;
    const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws';
    const reg = new BrowserAgentRegistry();
    const host = new BrowserAgentHost(wsUrl);
    managerRef.current = new BrowserAgentLifecycleManager(reg, host);
    (async () => {
      try { await managerRef.current!.resumeAll(); }
      catch {}
      finally { resumedRef.current = true; setResumed(true); }
      // If we already know the conversation, sync its local state now
      if (conversationId) {
        try {
          const infos = managerRef.current!.listRuntime(conversationId) || [];
          setBrowserRunning((prev) => {
            const next = { ...prev } as Record<string, boolean>;
            for (const i of infos) next[i.id] = true;
            return next;
          });
        } catch {}
      }
    })();
  }, []);

  // Whenever the conversationId becomes available, sync browser-running from runtime
  useEffect(() => {
    if (!conversationId || !managerRef.current) return;
    (async () => {
      try {
        // Clear any browser-registered agents for other conversations in this tab
        await managerRef.current!.clearOthers(conversationId);
      } catch {}
      try {
        const infos = managerRef.current!.listRuntime(conversationId) || [];
        // Replace map to reflect only current convo's browser agents
        setBrowserRunning(() => {
          const next: Record<string, boolean> = {};
          for (const i of infos) next[i.id] = true;
          return next;
        });
      } catch {}
    })();
  }, [conversationId, resumed]);

  // On load (or conversation change), ask orchestrator for ensured server-side agents
  useEffect(() => {
    if (!conversationId) return;
    if (!serverControlRef.current) serverControlRef.current = new WsControl(API_BASE.replace(/^http/, 'ws') + '/ws');
    (async () => {
      try {
        const ensured = await serverControlRef.current!.lifecycleGetEnsured(conversationId);
        const running = (ensured.ensured || []).map((e) => e.id);
        console.debug('[Configured] ensured (server)', running);
        setServerRunning((prev) => {
          const next: Record<string, boolean> = { ...prev };
          for (const id of running) next[id] = true;
          return next;
        });
        // per-agent statuses are shown; no global summary
      } catch {}
    })();
  }, [conversationId]);

  async function startServerAgent(agentId: string) {
    if (isCompleted) { setActionMsg('Conversation is completed; cannot start agents.'); return; }
    if (!conversationId) return;
    // mark just this agent as starting
    setStartingByAgent((m) => ({ ...m, [agentId]: true }));
    setActionMsg(`Ensuring ${agentId} on server…`);
    try {
      if (!serverControlRef.current) serverControlRef.current = new WsControl(API_BASE.replace(/^http/, 'ws') + '/ws');
      await serverControlRef.current.lifecycleEnsure(conversationId, [agentId]);
      setServerRunning((m) => ({ ...m, [agentId]: true }));
      setActionMsg(`${agentId} running on server.`);
    } catch (e: any) {
      console.error('[Configured] Failed to ensure server agent', e);
      setActionMsg(`Failed to start ${agentId} on server: ${e?.message || e}`);
    } finally {
      setStartingByAgent((m) => ({ ...m, [agentId]: false }));
    }
  }

  async function startBrowserAgent(agentId: string) {
    if (isCompleted) { setActionMsg('Conversation is completed; cannot start agents.'); return; }
    if (!conversationId || startingRef.current) return;
    startingRef.current = true;
    setStartingByAgent((m) => ({ ...m, [agentId]: true }));
    setActionMsg(`Starting ${agentId} in browser…`);
    try {
      const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws';
      if (!managerRef.current) {
        const reg = new BrowserAgentRegistry();
        const host = new BrowserAgentHost(wsUrl);
        managerRef.current = new BrowserAgentLifecycleManager(reg, host);
      }
      await managerRef.current.ensure(conversationId, [agentId]);
      setBrowserRunning((m) => ({ ...m, [agentId]: true }));
      setActionMsg(`${agentId} running in browser.`);
    } catch (e: any) {
      console.error('[Configured] Failed to start in browser', e);
      setActionMsg(`Failed to start ${agentId} in browser: ${e?.message || e}`);
    } finally {
      startingRef.current = false;
      setStartingByAgent((m) => ({ ...m, [agentId]: false }));
    }
  }

  async function stopAgent(agentId: string) {
    try {
      const wasBrowser = browserRunning[agentId];
      const wasServer = serverRunning[agentId];
      if (wasBrowser) {
        if (managerRef.current && conversationId) {
          await managerRef.current.stop(conversationId, [agentId]);
        }
        setBrowserRunning((m) => ({ ...m, [agentId]: false }));
      }
      if (wasServer && conversationId) {
        if (!serverControlRef.current) serverControlRef.current = new WsControl(API_BASE.replace(/^http/, 'ws') + '/ws');
        await serverControlRef.current.lifecycleStop(conversationId, [agentId]);
        setServerRunning((m) => ({ ...m, [agentId]: false }));
      }
      setActionMsg(`Stopped ${agentId}.`);
    } catch (e: any) {
      console.error('[Configured] Failed to stop agent', e);
      setActionMsg(`Failed to stop ${agentId}: ${e?.message || e}`);
    } finally {
    }
  }

  async function cancelConversation() {
    if (!conversationId || isCompleted || canceling) return;
    const ok = window.confirm('Cancel this conversation? This will finalize it and stop agents.');
    if (!ok) return;
    setCanceling(true);
    setActionMsg('Canceling conversation…');
    try {
      await wsRpcCall('sendMessage', {
        conversationId,
        agentId: 'system-orchestrator',
        messagePayload: {
          text: 'Canceled by user',
          outcome: { status: 'canceled', reason: 'user_canceled' },
        },
        finality: 'conversation',
      });
      setActionMsg('Conversation canceled.');
    } catch (e: any) {
      console.error('[Configured] Failed to cancel conversation', e);
      setActionMsg(`Failed to cancel: ${e?.message || String(e)}`);
    } finally {
      setCanceling(false);
    }
  }

  return (
    <div className="space-y-2">
      {error && <div className="text-rose-700">Error: {error}</div>}
      {conversationId ? (
        <div className="border rounded bg-white p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="font-medium flex items-center gap-2">
              <span>Conversation #{conversationId}</span>
              {isCompleted && (
                <span className={`text-xs px-2 py-0.5 rounded-full border ${finalStatus==='canceled' ? 'bg-amber-100 text-amber-800 border-amber-200' : finalStatus==='errored' ? 'bg-rose-100 text-rose-800 border-rose-200' : 'bg-emerald-100 text-emerald-700 border-emerald-200'}`}>
                  {finalStatus ? finalStatus[0].toUpperCase() + finalStatus.slice(1) : 'Completed'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!isCompleted && (
                <button
                  disabled={canceling}
                  onClick={cancelConversation}
                  className="px-3 py-1 text-sm bg-amber-600 text-white rounded disabled:opacity-50"
                  title="Finalize this conversation and stop agents"
                >Cancel</button>
              )}
              <a className="px-3 py-1 text-sm bg-indigo-600 text-white rounded" href={`/watch/#/conversation/${conversationId}`} target="_blank" rel="noreferrer">Open in Watch</a>
            </div>
          </div>

          {isCompleted && (
            <div className={`${finalStatus==='canceled' ? 'bg-amber-50 border-amber-200 text-amber-900' : finalStatus==='errored' ? 'bg-rose-50 border-rose-200 text-rose-900' : 'bg-emerald-50 border-emerald-200 text-emerald-800'} text-sm border rounded p-2`}>
              <div>This conversation is completed. Agents are stopped and cannot be restarted.</div>
              {(finalReason || finalStatus) && (
                <div className="mt-1">
                  {(finalStatus) && (<span className="font-medium">{finalStatus[0].toUpperCase() + finalStatus.slice(1)}</span>)}
                  {finalReason && (
                    <span> — Reason: <span className="font-medium">{finalReason}</span></span>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="text-xs text-slate-600 min-h-[1.25rem]">{actionMsg}</div>

          <div className="border-t pt-2">
            <div className="font-medium text-sm mb-1">Agents</div>
            <div className="text-xs text-slate-600 mb-2">Start each agent in your preferred place. Server starts use ensure-running and persist across reloads and restarts. Browser starts run locally.</div>
            <div className="space-y-2">
              {listAgentIds().map((aid) => {
                const isRunning = Boolean(browserRunning[aid] || serverRunning[aid]);
                const isStarting = Boolean(startingByAgent[aid]);
                const status = browserRunning[aid]
                  ? 'Browser'
                  : serverRunning[aid]
                  ? 'Server'
                  : isStarting
                  ? 'Starting…'
                  : 'Idle';
                const disableStart = isRunning || isStarting || isCompleted;
                const disableStop = !isRunning || isStarting;
                return (
                  <div
                    key={aid}
                    className="grid grid-cols-[1fr_50px_auto] gap-2 items-center"
                  >
                    <div className="font-mono text-xs px-2 py-1 border rounded bg-gray-50 truncate min-w-0" title={aid}>{aid}</div>
                    <div className="text-xs text-gray-700 text-center">{status}</div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={disableStart}
                        onClick={() => startBrowserAgent(aid)}
                        className="text-xs"
                      >Start in Browser</Button>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={disableStart}
                        onClick={() => startServerAgent(aid)}
                        className="text-xs"
                      >Start on Server</Button>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={disableStop}
                        onClick={() => stopAgent(aid)}
                        className="text-xs"
                      >Stop</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="border-t pt-2">
            <div className="font-medium text-sm mb-2">Thread (messages)</div>
            <div className="max-h-72 overflow-auto rounded border bg-slate-50 p-2 space-y-1 text-sm">
              {messages.length === 0 ? (
                <div className="text-slate-500 text-xs">No messages yet.</div>
              ) : (
                messages.map((m) => (
                  <div key={m.seq} className="bg-white border rounded px-2 py-1">
                    <div className="text-xs text-slate-500">{m.agentId} • seq {m.seq}</div>
                    <div>{(m as any).payload?.text || ''}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="border rounded bg-white p-3 space-y-2">
          <div className="text-sm">{error ? <span className="text-rose-700">Error: {error}</span> : 'Ready to start a conversation'}</div>
          <div className="flex gap-2">
            <button disabled={!config || isCreating} className="px-3 py-1 text-sm bg-blue-600 text-white rounded disabled:opacity-50" onClick={startConversationNow}>
              {isCreating ? 'Starting…' : 'Start Conversation'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
