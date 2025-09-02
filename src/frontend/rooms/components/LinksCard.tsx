import React from 'react';
import { Copy, ExternalLink } from 'lucide-react';

export function LinksCard({ agentCard, mcpUrl, onCopyAgent, onCopyMcp, copiedAgent, copiedMcp, clientHref, ctaPrimary, hideTitle }:{
  agentCard: string;
  mcpUrl: string;
  onCopyAgent: () => void;
  onCopyMcp: () => void;
  copiedAgent: boolean;
  copiedMcp: boolean;
  clientHref: string;
  ctaPrimary?: boolean;
  hideTitle?: boolean;
}) {
  return (
    <div className={hideTitle ? '' : 'space-y-3'}>
      {!hideTitle && (
        <div className="text-base font-semibold">Helpful Links</div>
      )}

      <div className="bg-white border border-border rounded-2xl p-3 shadow-sm">
        <div className="text-sm font-semibold mb-2">Agent Resources</div>
        <div className="flex items-center justify-between py-1.5">
          <div className="text-sm whitespace-nowrap">Agent Card URL</div>
          <button
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-gray-50 border border-gray-200 text-gray-700 hover:bg-gray-100"
            onClick={onCopyAgent}
            title={agentCard}
          >
            <Copy size={16} /> {copiedAgent ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="flex items-center justify-between py-1.5">
          <div className="text-sm whitespace-nowrap">MCP URL</div>
          <button
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-gray-50 border border-gray-200 text-gray-700 hover:bg-gray-100"
            onClick={onCopyMcp}
            title={mcpUrl}
          >
            <Copy size={16} /> {copiedMcp ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="bg-white border border-border rounded-2xl p-3 shadow-sm">
        <div className="text-sm font-semibold mb-2">Client Tools</div>
        <div className="flex items-center justify-between py-1.5">
          <div className="text-sm">Sample Client</div>
          <a
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-2xl ${ctaPrimary ? 'bg-slate-900 text-white' : 'bg-gray-50 border border-gray-200 text-gray-800 hover:bg-gray-100'}`}
            href={clientHref}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={16} /> Launch
          </a>
        </div>
      </div>

    </div>
  );
}
