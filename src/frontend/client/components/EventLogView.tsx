import React from 'react';
import type { UnifiedEvent } from '../types/events';

export const EventLogView: React.FC<{ events: UnifiedEvent[]; busy?: boolean }>
  = ({ events, busy = false }) => {
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
          </div>
        </div>
      </div>
      <div className="max-h-[320px] overflow-y-auto p-4 bg-gray-50">
        <ul className="space-y-2">
          {events.map((e) => (
            <li key={e.seq} className="bg-white border border-gray-200 rounded-lg p-3">
              <div className="text-xs text-gray-500 flex items-center justify-between">
                <span>#{e.seq} • {new Date(e.timestamp).toLocaleTimeString()} • {e.type}</span>
                <span className="font-mono">{(e as any).channel} • {(e as any).author}</span>
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
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
