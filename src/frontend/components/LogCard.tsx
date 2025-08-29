import React from 'react';

function tagFor(type: string): { label:string; cls:string } {
  switch (type) {
    case 'status_changed': return { label:'info', cls:'bg-blue-50 text-blue-700' };
    case 'compose_intent': return { label:'draft', cls:'bg-indigo-50 text-indigo-700' };
    case 'tool_call':
    case 'tool_result': return { label:'tools', cls:'bg-amber-50 text-amber-700' };
    case 'remote_received': return { label:'incoming', cls:'bg-purple-50 text-purple-700' };
    case 'remote_sent': return { label:'outgoing', cls:'bg-green-50 text-green-700' };
    default: return { label:'trace', cls:'bg-gray-100 text-gray-700' };
  }
}

export function LogCard({ rows }:{ rows: Array<{ id:string; ts?: string; type: string }> }) {
  return (
    <div className="card max-h-72 overflow-auto">
      <div className="small" style={{ fontWeight:600, marginBottom: 8 }}>Log</div>
      <div className="small">
        {rows.map((f) => {
          const ts = new Date(f.ts || Date.now()).toLocaleTimeString();
          const label = f.type.replace(/_/g,' ');
          const tag = tagFor(f.type);
          return (
            <div key={f.id} className="row items-center gap-2">
              <span className="muted w-[64px]">{ts}</span>
              <span className="flex-1">{label}</span>
              <span className={`pill ${tag.cls}`}>{tag.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

