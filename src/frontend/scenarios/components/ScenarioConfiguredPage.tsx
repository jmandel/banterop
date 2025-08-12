import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ScenarioDrivenAgent } from '$src/agents/scenario/scenario-driven.agent';
import { WsTransport } from '$src/agents/runtime/ws.transport';
import { LLMProviderManager } from '$src/llm/provider-manager';
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
  const [agentsRunning, setAgentsRunning] = useState<'none'|'browser'|'server'>('none');
  const [actionMsg, setActionMsg] = useState<string>('');
  const [starting, setStarting] = useState<boolean>(false);

  // Inline thread state
  const [messages, setMessages] = useState<UnifiedEvent[]>([]);
  const [convSnap, setConvSnap] = useState<any | null>(null);
  const eventWsRef = useRef<WebSocket | null>(null);
  const agentsRef = useRef<Map<string, ScenarioDrivenAgent>>(new Map());
  const startingRef = useRef<boolean>(false);

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
      // Also fetch a one-shot snapshot for safety
      wsRpcCall<any>('getConversation', { conversationId, includeScenario: false }).then((snap) => {
        setConvSnap(snap);
        const msgs: UnifiedEvent[] = (snap.events || []).filter((e: UnifiedEvent) => e.type === 'message');
        setMessages(msgs);
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
  const serverUrl = API_BASE.replace('/api', '');

  async function startInBrowser() {
    if (!conversationId || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setActionMsg('Starting agents in browser…');
    try {
      // Prepare provider manager
      const defaultModel = config?.meta?.agents?.[0]?.config?.model
        || convSnap?.metadata?.agents?.[0]?.config?.model
        || 'gemini-2.5-flash';
      const providerManager = new LLMProviderManager({ defaultLlmProvider: 'browserside', defaultLlmModel: defaultModel, serverUrl });
      // Clear any existing
      for (const [, agent] of agentsRef.current) agent.stop();
      agentsRef.current.clear();
      // Start per agent
      const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws';
      const agentMetas = (config?.meta?.agents && config.meta.agents.length
        ? config.meta.agents
        : (convSnap?.metadata?.agents || [])
      );
      for (const agentMeta of agentMetas) {
        const transport = new WsTransport(wsUrl);
        const agent = new ScenarioDrivenAgent(transport, { agentId: agentMeta.id, providerManager, turnRecoveryMode: 'restart' });
        agentsRef.current.set(agentMeta.id, agent);
        await agent.start(conversationId, agentMeta.id);
      }
      setAgentsRunning('browser');
      setActionMsg('Agents running in browser.');
    } catch (e: any) {
      console.error('[Configured] Failed to start in browser', e);
      setActionMsg(`Failed to start in browser: ${e?.message || e}`);
      setAgentsRunning('none');
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  async function startOnServer() {
    if (!conversationId) return;
    setStarting(true);
    setActionMsg('Ensuring agents on server…');
    try {
      // If running in browser, stop first
      if (agentsRunning === 'browser') {
        await stop();
      }
      const agentIds = listAgentIds();
      if (!agentIds || agentIds.length === 0) {
        setActionMsg('No agents found to start on server.');
        return;
      }
      await wsRpcCall('ensureAgentsRunningOnServer', { conversationId, agentIds });
      setAgentsRunning('server');
      setActionMsg('Agents running on server.');
    } catch (e: any) {
      console.error('[Configured] Failed to ensure server agents', e);
      setActionMsg(`Failed to start on server: ${e?.message || e}`);
    } finally { setStarting(false); }
  }

  async function stop() {
    setStarting(true);
    try {
      if (agentsRunning === 'browser') {
        for (const [, agent] of agentsRef.current) {
          try { agent.stop(); } catch {}
        }
        agentsRef.current.clear();
        setAgentsRunning('none');
        setActionMsg('Stopped browser agents.');
      } else if (agentsRunning === 'server') {
        if (!conversationId) return;
        const agentIds = listAgentIds();
        await wsRpcCall('stopAgentsOnServer', { conversationId, agentIds });
        setAgentsRunning('none');
        setActionMsg('Stopped server agents.');
      } else {
        setActionMsg('No agents running.');
      }
    } catch (e: any) {
      console.error('[Configured] Failed to stop agents', e);
      setActionMsg(`Failed to stop agents: ${e?.message || e}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-2">
      {error && <div className="text-rose-700">Error: {error}</div>}
      {conversationId ? (
        <div className="border rounded bg-white p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="font-medium">Conversation created: #{conversationId}</div>
            {agentsRunning !== 'none' && (
              <div className="text-xs text-slate-600">Running: <span className="font-semibold">{agentsRunning === 'browser' ? 'Browser' : 'Server'}</span></div>
            )}
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <button disabled={starting} className="px-3 py-1 text-sm bg-blue-600 text-white rounded disabled:opacity-50" onClick={startOnServer}>Start on Server</button>
            <button disabled={starting} className="px-3 py-1 text-sm bg-blue-600 text-white rounded disabled:opacity-50" onClick={startInBrowser}>Start in Browser</button>
            {agentsRunning !== 'none' && (
              <button disabled={starting} className="px-3 py-1 text-sm bg-slate-700 text-white rounded disabled:opacity-50" onClick={stop}>Stop</button>
            )}
            <a className="px-3 py-1 text-sm bg-indigo-600 text-white rounded" href={`/watch#/conversation/${conversationId}`} target="_blank" rel="noreferrer">Open in Watch</a>
          </div>

          {actionMsg && <div className="text-xs text-slate-600">{actionMsg}</div>}

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
