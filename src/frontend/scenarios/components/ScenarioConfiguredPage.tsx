import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

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
  const { config64 } = useParams<{ config64: string }>();
  const [config, setConfig] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [autostartMode, setAutostartMode] = useState<'none'|'client'|'server'>('none');
  const [autostartLog, setAutostartLog] = useState<string>('');

  useEffect(() => {
    try { if (!config64) throw new Error('No configuration'); setConfig(decodeConfigFromBase64URL(config64)); }
    catch (e: any) { setError(e?.message || 'Invalid configuration'); }
  }, [config64]);

  useEffect(() => {
    (async () => {
      if (!config) return;
      try {
        setIsCreating(true);
        const res = await wsRpcCall<{ conversationId: number }>('createConversation', config);
        setConversationId(res.conversationId);
        console.log('[Configured] Conversation created', res.conversationId, 'autostartMode=', autostartMode);
      } catch (e: any) {
        setError(e?.message);
      } finally {
        setIsCreating(false);
      }
    })();
  }, [config]);

  useEffect(() => {
    if (!config) return;
    try {
      const custom = (config.meta?.custom || {}) as any;
      const m = typeof custom.autostartMode === 'string' ? custom.autostartMode : 'none';
      setAutostartMode(m === 'client' || m === 'server' ? m : 'none');
    } catch {}
  }, [config]);

  // Attempt server autostart when requested
  useEffect(() => {
    (async () => {
      if (!conversationId || autostartMode !== 'server' || !config) return;
      try {
        const agentIds: string[] = (config.meta?.agents || []).map((a: any) => a.id);
        setAutostartLog(`Attempting server autostart for conversation ${conversationId} with agents: ${agentIds.join(', ')}`);
        console.log('[Configured] ensuring server agents', { conversationId, agentIds });
        const res = await wsRpcCall<{ ensured: Array<{ id: string }> }>('ensureAgentsRunningOnServer', { conversationId, agentIds });
        setAutostartLog(`Server autostart ensured: ${res.ensured.map(e => e.id).join(', ')}`);
        console.log('[Configured] ensured', res);
      } catch (e: any) {
        const msg = `Server autostart failed: ${e?.message || e}`;
        setAutostartLog(msg);
        console.error('[Configured] autostart error', e);
      }
    })();
  }, [conversationId, autostartMode, config]);

  return (
    <div className="space-y-2">
      {error && <div className="text-rose-700">Error: {error}</div>}
      {conversationId ? (
        <div className="border rounded bg-white p-3">
          <div>Conversation created: #{conversationId}</div>
          <div className="mt-2">
            <a className="px-3 py-1 text-sm bg-blue-600 text-white rounded" href={`/watch#/conversation/${conversationId}`} target="_blank" rel="noreferrer">Open in Watch</a>
            {/* Also offer opening the Scenario Launcher conversation viewer with autostart */}
            {autostartMode !== 'none' && (
              <a
                className="ml-2 px-3 py-1 text-sm bg-slate-700 text-white rounded"
                href={`/src/frontend/scenario-launcher/index.html#/conversation/${conversationId}?autostart=true&mode=${autostartMode}`}
                target="_blank"
                rel="noreferrer"
              >
                Open Conversation (Launcher)
              </a>
            )}
          </div>
          {autostartLog && (
            <div className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">{autostartLog}</div>
          )}
        </div>
      ) : (
        <div className="text-slate-500">{isCreating ? 'Creating conversation…' : 'Ready'}</div>
      )}
    </div>
  );
}
