export type A2APart =
  | { kind: "text"; text: string; metadata?: Record<string, any> }
  | { kind: "file"; file: { name: string; mimeType: string; uri?: string; bytes?: string }, metadata?: Record<string, any> };

export type A2AStatus = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";

export type A2AMessage = {
  role: "user" | "agent";
  parts: A2APart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  kind: "message";
  metadata?: any;
};

export type A2AStatusUpdate = {
  taskId: string;
  contextId: string;
  status: { state: A2AStatus; message?: A2AMessage };
  final?: boolean;
  kind: "status-update";
  cursor?: any;
  metadata?: any;
};

export type A2ATask = {
  id: string;
  contextId: string;
  status: { state: A2AStatus; message?: A2AMessage };
  history?: A2AMessage[];
  artifacts?: any[];
  kind: "task";
  metadata?: Record<string, any>;
};

export type A2AFrame = { result: A2ATask | A2AStatusUpdate | A2AMessage };
