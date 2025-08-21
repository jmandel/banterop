import React from 'react';
import type { UnifiedEvent } from '../types/events';

export const EventLogView: React.FC<{ events: UnifiedEvent[]; busy?: boolean }>
  = ({ events, busy = false }) => {
  const [showReasoning, setShowReasoning] = React.useState<boolean>(false);

  const containerStyle = (e: UnifiedEvent): string => {
    // Align colors with chat: user=indigo, planner=white/gray, agent=blue, trace=yellow, status=gray
    if (e.type === 'trace') return 'bg-yellow-50 border-yellow-200';
    if (e.type === 'status') return 'bg-gray-50 border-gray-200';
    if ((e as any).author === 'user') return 'bg-indigo-50 border-indigo-200';
    if ((e as any).author === 'agent') return 'bg-blue-50 border-blue-200';
    if ((e as any).author === 'planner') return 'bg-white border-gray-200';
    return 'bg-white border-gray-200';
  };

  const sourceBadge = (e: UnifiedEvent): React.ReactNode => {
    const a = (e as any).author;
    const base = 'px-2 py-0.5 rounded-full text-[10px] font-semibold';
    if (e.type === 'trace') return <span className={`${base} bg-yellow-100 text-yellow-900 border border-yellow-200`}>system</span>;
    if (e.type === 'status') return <span className={`${base} bg-gray-100 text-gray-800 border border-gray-200`}>status</span>;
    if (a === 'user') return <span className={`${base} bg-indigo-100 text-indigo-900 border border-indigo-200`}>user</span>;
    if (a === 'agent') return <span className={`${base} bg-blue-100 text-blue-900 border border-blue-200`}>agent</span>;
    if (a === 'planner') return <span className={`${base} bg-white text-slate-700 border border-gray-300`}>planner</span>;
    return <span className={`${base} bg-gray-100 text-gray-800 border border-gray-200`}>{String(a || 'unknown')}</span>;
  };
  return (
    <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
      <div className={`relative bg-gradient-to-r from-slate-500 to-slate-600 text-white p-4`}>
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-lg">Agent Event Log (read-only)</h3>
          <div className="flex items-center gap-2">
            {busy && (
              <span className="px-2 py-1 bg-white/20 rounded-full text-xs font-medium" title="Completions in progress">
                Thinking…
              </span>
            )}
            <span className="px-2 py-1 bg-white/20 rounded-full text-xs font-medium">
              {events.length} events
            </span>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                className="accent-white/90"
                checked={showReasoning}
                onChange={(e) => setShowReasoning(e.target.checked)}
              />
              <span className="opacity-90">Show reasoning</span>
            </label>
          </div>
        </div>
      </div>
      <div className="max-h-[320px] overflow-y-auto p-4 bg-gray-50">
        <ul className="space-y-2">
          {events.map((e) => (
            <li key={e.seq} className={`${containerStyle(e)} border rounded-lg p-3`}>
              <div className="text-xs text-gray-500 flex items-center justify-between">
                <span className="flex items-center gap-2">
                  {sourceBadge(e)}
                  <span>#{e.seq} • {new Date(e.timestamp).toLocaleTimeString()} • {e.type}</span>
                </span>
                <span className="font-mono">{(e as any).channel}</span>
              </div>
              <div className="mt-2 text-sm text-gray-800 whitespace-pre-wrap break-words">
                {e.type === 'message' && (
                  <>
                    <div>{(e.payload as any).text}</div>
                    {Array.isArray((e.payload as any).attachments) && (e.payload as any).attachments.length > 0 && (
                      <div className="mt-1 text-xs text-gray-600">
                        Attachments: {(e.payload as any).attachments.map((a: any) => a?.name).filter(Boolean).join(', ')}
                      </div>
                    )}
                  </>
                )}
                {e.type === 'tool_call' && (
                  <>
                    <div className="font-mono">CALL {(e.payload as any).name}</div>
                    <div className="mt-1 text-xs text-gray-600">args: {JSON.stringify((e.payload as any).args ?? {})}</div>
                  </>
                )}
                {e.type === 'tool_result' && (
                  <div className="text-xs text-gray-600">result: {JSON.stringify((e.payload as any).result ?? {})}</div>
                )}
                {e.type === 'read_attachment' && (
                  <div className="text-xs text-gray-600">
                    read "{(e.payload as any).name}": {(e.payload as any).ok ? 'ok' : 'blocked'}
                    {typeof (e.payload as any).text_excerpt === 'string' && (e.payload as any).text_excerpt && (
                      <pre className="bg-white border border-gray-200 rounded p-2 overflow-auto mt-1">
                        {(e.payload as any).text_excerpt}
                      </pre>
                    )}
                  </div>
                )}
                {e.type === 'status' && (
                  <div className="text-xs text-gray-600">state: {(e.payload as any).state}</div>
                )}
                {e.type === 'trace' && (
                  <div className="text-xs text-gray-600">{(e.payload as any).text}</div>
                )}
                {showReasoning && typeof (e as any).reasoning === 'string' && (e as any).reasoning.trim() && (
                  <div className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                    <span className="font-semibold mr-1">Reasoning:</span>
                    {(e as any).reasoning}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
