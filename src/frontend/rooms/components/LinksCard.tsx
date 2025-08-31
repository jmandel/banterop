import React from 'react';

export function LinksCard({ agentCard, mcpUrl, onCopyAgent, onCopyMcp, copiedAgent, copiedMcp, clientHref, ctaPrimary }:{
  agentCard: string;
  mcpUrl: string;
  onCopyAgent: () => void;
  onCopyMcp: () => void;
  copiedAgent: boolean;
  copiedMcp: boolean;
  clientHref: string;
  ctaPrimary?: boolean;
}) {
  return (
    <div className="card">
      <div className="row justify-between items-center">
        <div className="small font-semibold">Links</div>
      </div>
      <div className="row items-center mt-1.5 justify-between">
        <div className="small">Agent Card URL</div>
        <button className="btn secondary" onClick={onCopyAgent} title={agentCard}>{copiedAgent ? 'Copied' : 'Copy'}</button>
      </div>
      <div className="row items-center mt-1.5 justify-between">
        <div className="small">MCP URL</div>
        <button className="btn secondary" onClick={onCopyMcp} title={mcpUrl}>{copiedMcp ? 'Copied' : 'Copy'}</button>
      </div>
      <div className="row items-center mt-2 justify-between">
        <div className="small">Sample Client</div>
        <a className={`btn ${ctaPrimary ? '' : 'secondary'}`} href={clientHref} target="_blank" rel="noreferrer">Launch</a>
      </div>
    </div>
  );
}
