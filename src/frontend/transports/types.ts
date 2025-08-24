import type { A2APart, A2ATask, A2AMessage, A2AStatus } from "../../shared/a2a-types";

export type TransportSnapshot = {
  kind: 'task';
  id: string;
  status: { state: A2AStatus; message?: A2AMessage };
  history: A2AMessage[]; // oldest→newest (limited tail ok)
};

export interface TransportAdapter {
  kind(): 'a2a'|'mcp';
  // continuous tick stream: yield whenever "something may have changed"
  ticks(taskId: string, signal?: AbortSignal): AsyncGenerator<void>;
  // fetch the latest snapshot (may be synthetic in MCP)
  snapshot(taskId: string): Promise<TransportSnapshot | null>;
  // send a message, optionally starting a new task (A2A) / conversation (MCP)
  send(parts: A2APart[], opts: { taskId?: string; messageId?: string; finality?: 'none'|'turn'|'conversation' }): Promise<{ taskId: string; snapshot: TransportSnapshot }>;
  cancel(taskId: string): Promise<void>;
}
