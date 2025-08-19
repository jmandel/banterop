import { A2ABridgeTaskClient } from "./a2a-bridge-client";
import { McpTaskClient } from "./mcp-task-client";
import type { TaskClientLike } from "./task-client";

export type Protocol = "auto" | "a2a" | "mcp";

export function detectProtocolFromUrl(url: string): Exclude<Protocol, "auto"> | null {
  try {
    const m = url.match(/\/(a2a|mcp)(?:\b|\/|$)/);
    return (m ? (m[1] as any) : null);
  } catch { return null; }
}

export function createTaskClient(protocol: Protocol, endpointUrl: string): TaskClientLike {
  const selected = protocol === "auto" ? (detectProtocolFromUrl(endpointUrl) || "a2a") : protocol;
  if (selected === "mcp") return new McpTaskClient(endpointUrl);
  return new A2ABridgeTaskClient(endpointUrl);
}

