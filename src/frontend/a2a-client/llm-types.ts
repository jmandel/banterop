import type { A2AStatus } from "./a2a-types";

export type SendToAgentAttachmentArg = {
  name: string;
  mimeType?: string;
  bytes?: string; // base64
  uri?: string;
  summary?: string;
  docId?: string;
};

export type ToolCall =
  | { tool: "send_to_agent"; args: { text?: string; attachments?: SendToAgentAttachmentArg[] } }
  | { tool: "inspect_attachment"; args: { name: string; purpose?: string } }
  | { tool: "ask_user"; args: { question: string } }
  | { tool: "sleep"; args: { ms: number } }
  | { tool: "done"; args: { summary: string } };

export type ToolEvent = {
  tool: "inspect_attachment";
  args: { name: string; purpose?: string };
  result: {
    ok: boolean; private?: boolean; reason?: string;
    mimeType: string; size: number;
    description?: string; truncated?: boolean;
    text_excerpt?: string;
  };
  at: string;
};

export type PlannerEvent =
  | { type: 'asked_user'; at: string; question: string }
  | { type: 'user_reply'; at: string; text: string }
  | { type: 'sent_to_agent'; at: string; text?: string; attachments?: Array<{ name: string; mimeType: string }> }
  | { type: 'agent_message'; at: string; text?: string }
  | { type: 'agent_document_added'; at: string; name: string; mimeType: string };

export type LLMStepContext = {
  instructions: string;
  goals: string;
  status: A2AStatus;
  policy: { has_task: boolean; planner_mode?: "passthrough" | "autostart" | "approval" };
  counterpartHint?: string;
  
  available_files: Array<{
    name: string; mimeType: string; size: number;
    summary?: string; keywords?: string[]; last_inspected?: string;
    private?: boolean; priority?: boolean;
  }>;

  task_history_full: Array<{ role: "user" | "agent"; text: string }>;
  user_mediator_recent: Array<{ role: "user" | "planner" | "system"; text: string }>;

  tool_events_recent: ToolEvent[];
  planner_events_recent: PlannerEvent[];
  prior_mediator_messages: number;
};

export interface LLMProvider {
  name: string;
  ready(): Promise<boolean>;
  generateToolCall(ctx: LLMStepContext): Promise<ToolCall>;
}
