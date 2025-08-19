import { A2ABridgeTaskClient } from "./a2a-bridge-client";
import { McpTaskClient } from "./mcp-task-client";
import type { TaskClientLike } from "./task-client";

export type Protocol = "auto" | "a2a" | "mcp";

export function detectProtocolFromUrl(url: string): Exclude<Protocol, "auto"> | null {
  try {
    const u = new URL(url, (typeof window !== 'undefined' ? window.location.href : 'http://localhost'));
    const path = u.pathname || '';
    if (/\/(a2a)(?:\/?$)/i.test(path)) return 'a2a';
    if (/\/(mcp)(?:\/?$)/i.test(path)) return 'mcp';
    // Fallback: conservative regex on path only
    const m = path.match(/\/(a2a|mcp)(?:\/|$)/i);
    return (m ? (m[1].toLowerCase() as any) : null);
  } catch { return null; }
}

export function createTaskClient(protocol: Protocol, endpointUrl: string): TaskClientLike {
  const selected = protocol === "auto" ? (detectProtocolFromUrl(endpointUrl) || "a2a") : protocol;
  if (selected === "mcp") return new McpTaskClient(endpointUrl);
  return new A2ABridgeTaskClient(endpointUrl);
}
