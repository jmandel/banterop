export type BridgeEndpointInfo = {
  isOurs: boolean;
  config64?: string;
  apiBase?: string;
  protocol?: 'a2a' | 'mcp';
  serverBase?: string; // scheme+host (no /api)
};

export function parseBridgeEndpoint(url: string): BridgeEndpointInfo {
  try {
    const match = url.match(/^(https?:\/\/[^\/]+)(\/api)?\/bridge\/([^\/]+)\/(a2a|mcp)/);
    if (!match) return { isOurs: false };
    const serverBase = match[1];
    const apiBase = match[2] ? match[1] + match[2] : serverBase + '/api';
    const protocol = match[4] as 'a2a' | 'mcp';
    return { isOurs: true, config64: match[3], apiBase, protocol, serverBase };
  } catch {
    return { isOurs: false };
  }
}
