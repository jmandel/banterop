import type { A2APart, A2AMessage, A2AStatus } from "../../shared/a2a-types";

export type TransportSnapshot = {
  kind: "task";
  id: string;
  status: { state: A2AStatus; message?: A2AMessage };
  history: A2AMessage[];
};

export type SendOptions = {
  taskId?: string;
  messageId?: string;
  finality?: "none" | "turn" | "conversation";
};

export interface TransportAdapter {
  kind(): "a2a" | "mcp";
  send(parts: A2APart[], opts: SendOptions): Promise<{ taskId: string; snapshot: TransportSnapshot }>;
  snapshot(taskId: string): Promise<TransportSnapshot | null>;
  cancel(taskId: string): Promise<void>;
  ticks(taskId: string, signal?: AbortSignal): AsyncGenerator<void>;
}

