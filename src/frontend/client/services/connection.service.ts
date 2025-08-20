import { parseBridgeEndpoint } from '../bridge-endpoint';
import { detectProtocolFromUrl, createTaskClient, type Protocol } from '../protocols';
import { listMcpTools } from '../protocols/mcp-utils';
import type { TaskClientLike } from '../protocols/task-client';

export type PreviewResult =
  | { protocol: 'cannot-detect' }
  | { protocol: 'a2a'; status: 'connecting' | 'agent-card' | 'error'; error?: string; card?: any }
  | { protocol: 'mcp'; status: 'connecting' | 'tools' | 'error'; error?: string; tools?: string[] };

export async function refreshPreview(endpoint: string, protocol: Protocol): Promise<PreviewResult> {
  const ep = (endpoint || '').trim();
  if (!ep) return { protocol: 'cannot-detect' } as const;
  const requested = protocol;
  const parsed = parseBridgeEndpoint(ep);
  const effective: Exclude<Protocol, 'auto'> | null = requested === 'auto'
    ? ((parsed?.protocol as Exclude<Protocol,'auto'>) || (detectProtocolFromUrl(ep)))
    : (requested as Exclude<Protocol,'auto'>);
  if (!effective) return { protocol: 'cannot-detect' } as const;
  if (effective === 'a2a') {
    try {
      const isAgentCard = /\.well-known\/agent-card\.json$/i.test(ep);
      const url = isAgentCard ? ep : `${ep.replace(/\/?$/, '')}/.well-known/agent-card.json`;
      const res = await fetch(url);
      if (res.ok) {
        const card = await res.json();
        return { protocol: 'a2a', status: 'agent-card', card } as const;
      }
      return { protocol: 'a2a', status: 'error', error: `Agent card fetch failed: ${res.status}` } as const;
    } catch (e: any) {
      return { protocol: 'a2a', status: 'error', error: String(e?.message ?? e) } as const;
    }
  }
  // MCP
  try {
    const tools = await listMcpTools(ep);
    return { protocol: 'mcp', status: 'tools', tools } as const;
  } catch (e: any) {
    return { protocol: 'mcp', status: 'error', error: String(e?.message ?? e) } as const;
  }
}

export function detectEffectiveProtocol(endpoint: string, protocol: Protocol): Exclude<Protocol,'auto'> {
  const ep = (endpoint || '').trim();
  const requested = protocol;
  if (requested !== 'auto') return requested;
  const parsed = parseBridgeEndpoint(ep);
  return (parsed?.protocol as any) || (detectProtocolFromUrl(ep) || 'a2a');
}

export function createClient(endpoint: string, protocol: Exclude<Protocol,'auto'>): TaskClientLike {
  return createTaskClient(protocol, endpoint);
}

