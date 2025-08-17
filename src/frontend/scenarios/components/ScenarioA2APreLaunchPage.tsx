import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardHeader } from '../../ui';
import { useParams, Link } from 'react-router-dom';
import { PreLaunchShared } from './PreLaunchShared';
import { sha256Base64Url } from '$src/lib/hash';

declare const __API_BASE__: string | undefined;
const API_BASE: string =
  (typeof window !== 'undefined' && (window as any).__APP_CONFIG__?.API_BASE) ||
  (typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : 'http://localhost:3000/api');

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

export function ScenarioA2APreLaunchPage() {
  const { scenarioId, config64 = '' } = useParams<{ scenarioId: string; config64: string }>();
  const [scenarioName, setScenarioName] = useState<string>('');
  const [meta, setMeta] = useState<any>(null);
  const [hash, setHash] = useState<string>('');
  const [matches, setMatches] = useState<number[]>([]);
  const [subState, setSubState] = useState<'idle'|'connecting'|'open'|'closed'>('idle');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try { setMeta(base64UrlDecodeJson(config64)); } catch {}
      try {
        const h = await sha256Base64Url(config64);
        if (!cancelled) setHash(h);
      } catch {}
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

  // Minimal one-shot WS JSON-RPC helper
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

  // Live discovery: subscribe to conversation creations and filter by template hash marker
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

  // Historical discovery: fetch existing conversations and match by marker
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

  const a2aUrl = useMemo(() => (
    `${API_BASE}/bridge/${config64}/a2a`
  ), [config64]);
  const [copiedUrl, copyUrl] = useCopy(a2aUrl);

  const prettyMeta = meta ? JSON.stringify(meta, null, 2) : '';

  return (
    <>
      <PreLaunchShared
        heading="A2A Pre‑Launch"
        serverUrlLabel="A2A Server URL"
        serverUrl={a2aUrl}
        onCopy={copyUrl}
        copied={copiedUrl}
        meta={{ scenarioId, startingAgentId: meta?.startingAgentId }}
        hash={hash}
        subState={subState}
        matches={matches}
        urlNote={<span>Post JSON‑RPC requests to this URL. For streaming, set <code>accept: text/event-stream</code>.</span>}
      />

      <div className="p-6 max-w-4xl mx-auto space-y-4">
        <Card className="space-y-2">
          <CardHeader title="How To Use (A2A)" />
          <ul className="text-sm text-slate-700 space-y-1 list-disc pl-5">
            <li><span className="font-medium">message/send</span>: starts a new task (no taskId) or continues a non‑terminal one (with taskId).</li>
            <li><span className="font-medium">message/stream</span>: same payload as message/send; responds with SSE stream of JSON‑RPC frames.</li>
            <li><span className="font-medium">tasks/get</span>: returns snapshot (status + full history).</li>
            <li><span className="font-medium">tasks/resubscribe</span>: resume streaming updates for an existing task.</li>
            <li><span className="font-medium">tasks/cancel</span>: end the conversation with outcome=canceled.</li>
          </ul>
        </Card>

        <Card className="space-y-2">
          <CardHeader title="Template (decoded)" />
          <pre className="text-xs bg-slate-50 p-2 rounded border overflow-auto">{prettyMeta}</pre>
        </Card>
      </div>
    </>
  );
}
