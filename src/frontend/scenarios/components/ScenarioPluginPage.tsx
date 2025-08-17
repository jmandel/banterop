import React, { useEffect, useMemo, useState } from 'react';
import { sha256Base64Url } from '$src/lib/hash';
import { useParams, Link } from 'react-router-dom';
import { PreLaunchShared } from './PreLaunchShared';

declare const __API_BASE__: string | undefined;
const API_BASE: string =
  (typeof window !== 'undefined' && (window as any).__APP_CONFIG__?.API_BASE) ||
  (typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : 'http://localhost:3000/api');

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

function base64UrlDecodeJson<T = any>(b64url: string): T {
  const normalized = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const base64 = normalized + pad;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

function useCopy(text: string): [boolean, () => void] {
  const [ok, setOk] = useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setOk(true);
      setTimeout(() => setOk(false), 1000);
    }).catch(() => {});
  };
  return [ok, onCopy];
}

export function ScenarioPluginPage() {
  const { scenarioId, config64 = '' } = useParams<{ scenarioId: string; config64: string }>();
  const [hash, setHash] = useState<string>('');
  const [matches, setMatches] = useState<number[]>([]);
  const [subState, setSubState] = useState<'idle'|'connecting'|'open'|'closed'>('idle');
  const [meta, setMeta] = useState<any>(null);
  const [scenarioName, setScenarioName] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setMeta(base64UrlDecodeJson(config64));
      } catch {}
      const h = await sha256Base64Url(config64);
      if (!cancelled) setHash(h);
      // Try to load scenario name for breadcrumb
      if (scenarioId) {
        try {
          const url = `${API_BASE}/scenarios/${encodeURIComponent(scenarioId)}`;
          const res = await fetch(url);
          if (res.ok) {
            const s = await res.json();
            if (!cancelled) setScenarioName(s?.name || s?.config?.metadata?.title || scenarioId);
          } else {
            if (!cancelled) setScenarioName(scenarioId);
          }
        } catch {
          if (!cancelled) setScenarioName(scenarioId);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [config64]);

  useEffect(() => {
    if (!hash) return;
    const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    setSubState('connecting');
    ws.onopen = () => {
      setSubState('open');
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'subscribeConversations' }));
    };
    ws.onmessage = async (evt) => {
      try {
        const msg = JSON.parse(String(evt.data));
        if (msg.method === 'conversation' && msg.params?.conversationId) {
          const cid = Number(msg.params.conversationId);
          try {
            const conv = await wsRpcCall<any>('getConversation', { conversationId: cid, includeScenario: false });
            const marker = conv?.metadata?.custom?.bridgeConfig64Hash;
            if (marker && marker === hash) {
              setMatches((prev) => prev.includes(cid) ? prev : [...prev, cid]);
            }
          } catch {}
        }
      } catch {}
    };
    ws.onclose = () => setSubState('closed');
    return () => { try { ws.close(); } catch {} };
  }, [hash]);

  // Fetch existing matching conversations on load (historical discovery)
  useEffect(() => {
    if (!hash) return;
    let cancelled = false;
    (async () => {
      try {
        const url = `${API_BASE}/debug/conversations`;
        const res = await fetch(url);
        if (!res.ok) return;
        const list: any[] = await res.json();
        const found: number[] = [];
        for (const item of list) {
          const marker = item?.metadata?.custom?.bridgeConfig64Hash;
          if (marker && marker === hash) {
            found.push(Number(item.conversation));
          }
        }
        if (!cancelled && found.length) {
          setMatches((prev) => {
            const s = new Set(prev);
            for (const id of found) s.add(id);
            return Array.from(s);
          });
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [hash]);

  const mcpUrl = useMemo(() => (
    `${API_BASE}/bridge/${config64}/mcp`
  ), [config64]);
  const [copiedUrl, copyUrl] = useCopy(mcpUrl);
  const prettyMeta = meta ? JSON.stringify(meta, null, 2) : '';

  return (
    <>
      <PreLaunchShared
        heading="MCP Pre‑Launch"
        serverUrlLabel="MCP Server URL"
        serverUrl={mcpUrl}
        onCopy={copyUrl}
        copied={copiedUrl}
        meta={{ scenarioId, startingAgentId: meta?.startingAgentId }}
        hash={hash}
        subState={subState}
        matches={matches}
        urlNote={null}
      />

      <div className="p-6 max-w-4xl mx-auto space-y-4">
        <div className="p-4 border rounded space-y-2 bg-white">
          <div className="text-sm font-semibold">Template (decoded)</div>
          <pre className="text-xs bg-slate-50 p-2 rounded border overflow-auto">{prettyMeta}</pre>
        </div>

        <div className="p-4 border rounded space-y-2 bg-white">
          <div className="text-sm font-semibold">How To Use (MCP)</div>
          <ul className="text-sm text-slate-700 space-y-1 list-disc pl-5">
            <li><span className="font-medium">begin_chat_thread</span>: starts a new conversation from this template.</li>
            <li><span className="font-medium">send_message_to_chat_thread</span>: input — <code>conversationId</code>, <code>message</code>, optional <code>attachments[]</code>; output — <code>{`{ ok: true, guidance, status: 'waiting' }`}</code>.</li>
            <li>
              <span className="font-medium">check_replies</span>: input — <code>conversationId</code>, optional <code>waitMs</code> (default 10000); output includes:
              <ul className="mt-1 space-y-1 list-disc pl-5">
                <li>
                  <code>messages</code>: array of objects with keys:
                  <span className="ml-1"><code>from</code>, <code>at</code> (ISO), <code>text</code>,</span>
                  <span className="ml-1"><code>attachments</code> (array of objects: <code>name</code>, <code>contentType</code>, <code>summary?</code>, <code>docId?</code>)</span>
                  — only replies since your last message.
                </li>
                <li><code>guidance</code>: short hint (e.g., “Your turn to respond.”).</li>
                <li><code>status</code>: <code>input_required</code> | <code>waiting</code>.</li>
                <li><code>conversation_ended</code>: boolean.</li>
              </ul>
            </li>
          </ul>
          <div className="text-xs text-slate-500">External client speaks as: <span className="font-mono">{meta?.startingAgentId || '(unset)'}</span></div>
        </div>
      </div>
    </>
  );
}
