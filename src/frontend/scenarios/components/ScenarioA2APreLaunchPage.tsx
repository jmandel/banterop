import React, { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try { setMeta(base64UrlDecodeJson(config64)); } catch {}
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

  const a2aUrl = useMemo(() => (
    `${API_BASE}/bridge/${config64}/a2a`
  ), [config64]);
  const [copiedUrl, copyUrl] = useCopy(a2aUrl);

  const prettyMeta = meta ? JSON.stringify(meta, null, 2) : '';

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div>
        <nav className="text-sm text-slate-600 mb-1">
          <Link to="/scenarios" className="hover:underline">Scenarios</Link>
          <span className="mx-1">/</span>
          <Link to={`/scenarios/${encodeURIComponent(scenarioId)}`} className="hover:underline">{scenarioName || scenarioId}</Link>
          <span className="mx-1">/</span>
          <Link to={`/scenarios/${encodeURIComponent(scenarioId)}/run?mode=a2a`} className="hover:underline">Run</Link>
          <span className="mx-1">/</span>
          <span className="text-slate-500">A2A Plugin</span>
        </nav>
        <h1 className="text-2xl font-semibold">A2A Pre‑Launch</h1>
      </div>

      <div className="p-4 border rounded">
        <div className="text-sm text-slate-600 mb-2">Plug‑In Settings</div>
        <div className="text-sm"><span className="text-slate-500">Scenario:</span> <span className="font-mono">{meta?.scenarioId || '(none)'}</span></div>
        <div className="text-sm"><span className="text-slate-500">External Agent:</span> <span className="font-mono">{meta?.startingAgentId || '(unset)'}</span></div>
      </div>

      <div className="p-4 border rounded">
        <div className="text-sm text-slate-600 mb-2">A2A Server URL</div>
        <div className="font-mono break-all p-2 bg-slate-50 rounded border">{a2aUrl}</div>
        <div className="mt-2 flex items-center gap-2">
          <button onClick={copyUrl} className="px-2 py-1 text-xs border rounded hover:bg-gray-50">{copiedUrl ? 'Copied!' : 'Copy URL'}</button>
          <div className="text-xs text-slate-600">
            Post JSON‑RPC requests to this URL. For streaming, set <code>accept: text/event-stream</code>.
          </div>
        </div>
      </div>

      <div className="p-4 border rounded space-y-2">
        <div className="text-sm font-semibold">How To Use (A2A)</div>
        <ul className="text-sm text-slate-700 space-y-1" style={{ listStyleType: 'disc', paddingLeft: 20 }}>
          <li><span className="font-medium">message/send</span>: starts a new task (no taskId) or continues a non‑terminal one (with taskId).</li>
          <li><span className="font-medium">message/stream</span>: same payload as message/send; responds with SSE stream of JSON‑RPC frames.</li>
          <li><span className="font-medium">tasks/get</span>: returns snapshot (status + full history).</li>
          <li><span className="font-medium">tasks/resubscribe</span>: resume streaming updates for an existing task.</li>
          <li><span className="font-medium">tasks/cancel</span>: end the conversation with outcome=canceled.</li>
        </ul>
      </div>

      <div className="p-4 border rounded space-y-2">
        <div className="text-sm font-semibold">Template (decoded)</div>
        <pre className="text-xs bg-slate-50 p-2 rounded border overflow-auto">{prettyMeta}</pre>
      </div>
    </div>
  );
}
