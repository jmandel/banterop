import type { A2APart, A2AMessage, A2AStatus, A2ANextState } from "../../shared/a2a-types";

export type TransportSnapshot = {
  kind: "task";
  id: string;
  status: { state: A2AStatus; message?: A2AMessage };
  history: A2AMessage[];
};

export type SendOptions = {
  taskId?: string;
  messageId?: string;
  nextState?: A2ANextState;
  // Optional extension payload to merge under metadata[A2A_EXT_URL]
  extension?: Record<string, any>;
};

export interface TransportAdapter {
  kind(): "a2a" | "mcp";
  send(parts: A2APart[], opts: SendOptions): Promise<{ taskId: string; snapshot: TransportSnapshot }>;
  snapshot(taskId: string): Promise<TransportSnapshot | null>;
  cancel(taskId: string): Promise<void>;
  ticks(taskId: string, signal?: AbortSignal): AsyncGenerator<void>;
}
