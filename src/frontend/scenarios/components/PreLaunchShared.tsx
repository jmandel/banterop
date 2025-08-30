import React, { useState } from 'react';

type Props = {
  heading: string;
  serverUrlLabel: string;
  serverUrl: string;
  onCopy: () => void;
  copied: boolean;
  meta: { scenarioId?: string; startingAgentId?: string };
  hash: string;
  subState: 'idle'|'connecting'|'open'|'closed'|string;
  matches: number[];
  // Optional helper text below the URL
  urlNote?: React.ReactNode;
};

function displayUrl(url: string): string {
  if (!url) return '';
  const max = 64;
  if (url.length <= max) return url;
  const head = url.slice(0, 40);
  const tail = url.slice(-16);
  return `${head}…${tail}`;
}

export function PreLaunchShared({ heading, serverUrlLabel, serverUrl, onCopy, copied, meta, hash, subState, matches, urlNote }: Props) {
  const [showInfo, setShowInfo] = useState(false);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);
  const statusLabel = (() => {
    const s = String(subState).toLowerCase();
    if (s === 'open') return 'open';
    if (s === 'connecting') return 'connecting';
    if (s === 'closed') return 'closed';
    return s || 'idle';
  })();
  const statusColor = (() => {
    switch (statusLabel) {
      case 'open': return 'bg-green-500';
      case 'connecting': return 'bg-yellow-500';
      case 'closed': return 'bg-red-500';
      default: return 'bg-gray-400';
    }
  })();
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <h1 className="text-2xl font-semibold">{heading}</h1>

      {/* Settings */}
      <div className="p-4 border rounded bg-white">
        <div className="text-sm text-slate-600 mb-2">Plug‑In Settings</div>
        <div className="text-sm"><span className="text-slate-500">Scenario:</span> <span className="font-mono">{meta?.scenarioId || '(none)'}</span></div>
        <div className="text-sm"><span className="text-slate-500">Client speaks as:</span> <span className="font-mono">{meta?.startingAgentId || '(unset)'}</span></div>
      </div>

      {/* Server URL with big copy button */}
      <div className="p-4 border rounded bg-white space-y-2">
        <div className="text-sm text-slate-600">{serverUrlLabel}</div>
        <div
          className="flex items-center gap-3"
          style={{ userSelect: 'none', WebkitUserSelect: 'none', msUserSelect: 'none', MozUserSelect: 'none', WebkitTouchCallout: 'none' } as React.CSSProperties}
          onMouseDown={(e) => { e.preventDefault(); }}
          onSelectStart={(e) => { e.preventDefault(); }}
        >
          <div
            className="font-mono p-2 bg-slate-50 rounded border text-sm truncate grow select-none"
            onMouseDown={(e) => { e.preventDefault(); }}
            onSelectStart={(e) => { e.preventDefault(); }}
            draggable={false}
            title={serverUrl}
          >
            {displayUrl(serverUrl)}
          </div>
          <button onClick={onCopy} className={`px-3 py-2 rounded text-sm shadow ${copied ? 'bg-green-600 text-white' : 'bg-primary text-primary-foreground hover:opacity-90'}`}>
            {copied ? 'Copied!' : 'Copy URL'}
          </button>
        </div>
        {urlNote && (
          <div className="text-xs text-slate-600">{urlNote}</div>
        )}
      </div>

      {/* Full-width conversations with inline hash info */}
      <div className="p-4 border rounded bg-white">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm text-slate-600">Conversations</div>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <div className="flex items-center gap-1" title={`Connection: ${statusLabel}`} aria-label={`Connection: ${statusLabel}`}>
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${statusColor}`} />
            </div>
            <div className="inline-flex items-center">
              <button
                type="button"
                aria-label="Template hash info"
                title="Template hash info"
                onMouseEnter={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const width = 288; // w-72
                  let left = r.right - width;
                  if (left < 8) left = 8;
                  let top = r.bottom + 8;
                  const estHeight = 160;
                  if (top + estHeight > window.innerHeight) top = Math.max(8, r.top - 8 - estHeight);
                  setTipPos({ left, top });
                  setShowInfo(true);
                }}
                onMouseLeave={() => setShowInfo(false)}
                onFocus={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const width = 288;
                  let left = r.right - width;
                  if (left < 8) left = 8;
                  let top = r.bottom + 8;
                  const estHeight = 160;
                  if (top + estHeight > window.innerHeight) top = Math.max(8, r.top - 8 - estHeight);
                  setTipPos({ left, top });
                  setShowInfo(true);
                }}
                onBlur={() => setShowInfo(false)}
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const width = 288;
                  let left = r.right - width;
                  if (left < 8) left = 8;
                  let top = r.bottom + 8;
                  const estHeight = 160;
                  if (top + estHeight > window.innerHeight) top = Math.max(8, r.top - 8 - estHeight);
                  setTipPos({ left, top });
                  setShowInfo((v) => !v);
                }}
                aria-haspopup="dialog"
                aria-expanded={showInfo}
                className="w-8 h-8 inline-flex items-center justify-center rounded-full border text-slate-700 bg-white hover:bg-slate-50 text-base"
              >
                i
              </button>
              {showInfo && tipPos && (
                <div className="fixed z-50 w-72 p-3 bg-panel border border-border rounded shadow-lg text-xs text-text" style={{ left: tipPos.left, top: tipPos.top }}>
                  <div className="font-medium mb-1">Template hash</div>
                  <div className="mb-2">Used to stamp and discover conversations that match this pre‑launch config.</div>
                  <div className="font-mono break-all text-slate-600">{hash || '(computing…)'}
                  </div>
              </div>)}
            </div>
          </div>
        </div>
        {(!matches || matches.length === 0) ? (
          <div className="text-sm text-slate-600 italic">Waiting for matching conversations…</div>
        ) : (
          <div className="mt-1 space-y-1">
            {matches.map((cid) => (
              <div key={cid} className="flex items-center gap-3 text-sm">
                <span>Conversation #{cid}</span>
                <a className="text-primary hover:underline" href={`/watch/#/conversation/${cid}`} target="_blank" rel="noreferrer">Open in Watch</a>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
