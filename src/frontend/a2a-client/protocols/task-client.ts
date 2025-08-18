import type { A2APart, A2ATask, A2AStatus } from "../a2a-types";

export type TaskClientEventType = "new-task" | "error";

export interface TaskClientLike {
  on<T = any>(eventType: TaskClientEventType, cb: (ev: T) => void): () => void;

  getTask(): A2ATask | null;
  getTaskId(): string | undefined;
  getStatus(): A2AStatus | "initializing";

  resume(taskId: string): Promise<void>;
  startNew(parts: A2APart[]): Promise<void>;
  send(parts: A2APart[]): Promise<void>;
  cancel(): Promise<void>;
  clearLocal(): void;
}

