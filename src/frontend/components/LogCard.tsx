import React from 'react';
import type { Fact } from '../../shared/journal-types';
import { ExternalLink } from 'lucide-react';

function typeLabel(type: string): string { return String(type || '').replace(/_/g, ' '); }

function tagFor(type: string): { label:string; cls:string } {
  switch (type) {
    case 'status_changed': return { label: typeLabel(type), cls:'bg-primary-50 text-primary-800' };
    case 'compose_intent': return { label: typeLabel(type), cls:'bg-accent-50 text-accent-800' };
    case 'tool_call':
    case 'tool_result': return { label: typeLabel(type), cls:'bg-amber-50 text-amber-700' };
    case 'remote_received': return { label: typeLabel(type), cls:'bg-purple-50 text-purple-700' };
    case 'remote_sent': return { label: typeLabel(type), cls:'bg-green-50 text-green-700' };
    case 'attachment_added': return { label: typeLabel(type), cls:'bg-teal-50 text-teal-700' };
    case 'agent_question': return { label: typeLabel(type), cls:'bg-rose-50 text-rose-700' };
    case 'user_answer': return { label: typeLabel(type), cls:'bg-emerald-50 text-emerald-700' };
    case 'user_guidance': return { label: typeLabel(type), cls:'bg-fuchsia-50 text-fuchsia-700' };
    case 'compose_dismissed': return { label: typeLabel(type), cls:'bg-gray-50 text-gray-600' };
    case 'sleep': return { label: typeLabel(type), cls:'bg-slate-50 text-slate-700' };
    default: return { label: typeLabel(type), cls:'bg-gray-100 text-gray-700' };
  }
}

function preview(text: string, n = 72): string {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function shortId(id?: string, tail = 6): string {
  const s = String(id || '').trim();
  if (!s) return '';
  return s.length <= tail ? s : `…${s.slice(-tail)}`;
}

function summarize(f: Fact): string {
  switch (f.type) {
    case 'status_changed': return `${f.a2a}`;
    case 'remote_received': return `${preview(f.text)}${(f.attachments && f.attachments.length) ? ` (+${f.attachments.length} att)` : ''}`;
    case 'remote_sent': return `${preview(f.text)}${(f.attachments && f.attachments.length) ? ` (+${f.attachments.length} att)` : ''}`;
    case 'attachment_added': return `${f.name} (${f.mimeType || 'application/octet-stream'})`;
    case 'tool_call': {
      const keys = Object.keys(f.args || {}).slice(0, 3);
      const extra = Object.keys(f.args || {}).length > 3 ? ', …' : '';
      return `${f.name}(${keys.join(', ')}${extra})${f.why ? ` — ${preview(f.why, 40)}` : ''}`;
    }
    case 'tool_result': return `${f.ok ? 'ok' : 'error'}${f.error ? ` — ${preview(f.error, 60)}` : (typeof f.result === 'string' ? ` — ${preview(f.result, 60)}` : '')}${f.why ? ` — ${preview(f.why, 40)}` : ''}`;
    case 'agent_question': return `${preview(f.prompt)}${f.required ? ' (required)' : ''}`;
    case 'agent_answer': return preview(f.text);
    case 'user_answer': return preview(f.text);
    case 'user_guidance': return preview(f.text);
    case 'compose_intent': return `${preview(f.text)}${(f.attachments && f.attachments.length) ? ` (+${f.attachments.length} att)` : ''}`;
    case 'compose_dismissed': return `dismissed ${shortId(f.composeId)}` as any;
    case 'sleep': return f.reason ? preview(f.reason, 60) : (f.why ? preview(f.why, 60) : '');
    default: return '';
  }
}

function openJsonInNewTab(obj: unknown) {
  try {
    const data = JSON.stringify(obj, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    // Revoke after a minute
    setTimeout(() => { try { URL.revokeObjectURL(url) } catch {} }, 60_000);
  } catch {}
}

export function LogCard({ rows, all, fill }:{ rows: Array<Fact>; all?: Array<Fact>; fill?: boolean }) {
  const outerClass = fill
    ? 'card flex-1 min-h-0 flex flex-col overflow-hidden'
    : 'card max-h-72 overflow-y-auto overflow-x-hidden';
  const listClass = fill ? 'small flex-1 overflow-y-auto overflow-x-hidden' : 'small';
  function openAll() { openJsonInNewTab(all && all.length ? all : rows); }
  return (
    <div className={outerClass}>
      <div className="small row items-center justify-between" style={{ fontWeight:600, marginBottom: 8 }}>
        <span>Log</span>
        <button
          className="p-1 rounded hover:bg-gray-100 text-gray-600"
          title="Open full journal JSON in new tab"
          aria-label="Open full journal JSON in new tab"
          onClick={openAll}
        >
          <ExternalLink size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div className={listClass}>
        {rows.map((f) => {
          const tag = tagFor(f.type);
          const summary = summarize(f);
          return (
            <button
              key={(f as any).id}
              type="button"
              className="w-full text-left grid grid-cols-[auto_1fr_24px] items-center gap-2 py-0.5 cursor-pointer rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-200"
              title="Open full entry JSON in new tab"
              onClick={() => openJsonInNewTab(f)}
              onKeyDown={(e)=>{ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openJsonInNewTab(f); } }}
            >
              <span className={`pill ${tag.cls}`}>{tag.label}</span>
              <span className="min-w-0 truncate whitespace-nowrap text-gray-700" title={summary}>
                {summary}
              </span>
              <span className="justify-self-end text-gray-600 opacity-80">
                <ExternalLink size={16} strokeWidth={1.75} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
