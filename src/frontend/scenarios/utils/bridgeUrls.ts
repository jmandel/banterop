export type BridgeProtocol = 'a2a' | 'mcp';

// Given an API base like http://host:port/api and a config64, return
// a display label and URL to hand to an external client.
export function buildBridgeEndpoint(apiBase: string, protocol: BridgeProtocol, config64: string): { label: string; url: string } {
  const cleanBase = (apiBase || '').replace(/\/$/, '');
  if (protocol === 'mcp') {
    return {
      label: 'MCP Server URL',
      url: `${cleanBase}/bridge/${encodeURIComponent(config64)}/mcp`,
    };
  }
  // A2A: prefer the well-known Agent Card URL; clients read card.url for JSON-RPC base
  return {
    label: 'Agent Card URL',
    url: `${cleanBase}/bridge/${encodeURIComponent(config64)}/a2a/.well-known/agent-card.json`,
  };
}

