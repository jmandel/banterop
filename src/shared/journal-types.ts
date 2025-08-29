// FlipProxy + Planner Plugin — Journal Types (v0.4 — unified compose-only send path)
export interface Cut { seq:number }

export interface AttachmentMeta {
  name:string; mimeType:string; origin?:'inbound'|'user'|'synthesized'; size?:number;
}

type Stamp = { seq:number; ts:string; id:string }
type PlannerWhy = { why?: string };

export type Fact =
  | ({ type:'status_changed'
     ; a2a:'initializing'|'submitted'|'working'|'input-required'|'completed'|'failed'|'canceled'|'rejected'|'auth-required'|'unknown'
     } & Stamp)
  | ({ type:'remote_received'
     ; messageId:string
     ; text:string
     ; attachments?:AttachmentMeta[]
     } & Stamp)
  | ({ type:'remote_sent'
     ; messageId:string
     ; text:string
     ; attachments?:AttachmentMeta[]
     ; composeId?: string
     } & Stamp)
  | ({ type:'attachment_added'
     ; name:string
     ; mimeType:string
     ; bytes:string
     ; origin:'inbound'|'user'|'synthesized'
     ; producedBy?:{ callId:string; name:string; args:Record<string,unknown> }
     } & Stamp)
  | ({ type:'tool_call'
     ; callId:string
     ; name:string
     ; args:Record<string,unknown>
     } & PlannerWhy & Stamp)
  | ({ type:'tool_result'
     ; callId:string
     ; ok:boolean
     ; result?:unknown
     ; error?:string
     } & PlannerWhy & Stamp)
  | ({ type:'agent_question'
     ; qid:string
     ; prompt:string
     ; required?:boolean
     ; placeholder?:string
     } & PlannerWhy & Stamp)
  | ({ type:'agent_answer'
     ; qid:string
     ; text:string
     } & Stamp)
  | ({ type:'user_answer'
     ; qid:string
     ; text:string
     } & Stamp)
  | ({ type:'user_guidance'
     ; gid:string
     ; text:string
     } & Stamp)
  | ({ type:'compose_intent'
     ; composeId:string
     ; text:string
     ; attachments?:AttachmentMeta[]
     ; nextStateHint?: import('./a2a-types').A2ANextState
     } & PlannerWhy & Stamp)
  | ({ type:'compose_dismissed'
     ; composeId:string
     } & Stamp)
  | ({ type:'sleep'
     ; reason?:string
     } & PlannerWhy & Stamp);

export type ProposedFact = Omit<Fact, keyof Stamp>;

export interface PlanInput { cut:Cut; facts:ReadonlyArray<Fact> }

export type LlmMessage =
  | { role:'system'; content:string }
  | { role:'user'; content:string }
  | { role:'assistant'; content:string };

export interface LlmResponse { text:string }
export interface LlmProvider {
  chat(req:{ model?:string; messages:LlmMessage[]; temperature?:number; maxTokens?:number; signal?:AbortSignal }): Promise<LlmResponse>
  listModels?(): Promise<string[]>
}

// --- Planner API (lightweight v0.3/v0.4 compat) ---
export type TerminalFact = ProposedFact;

export type PlanContext<Cfg = unknown> = {
  signal?: AbortSignal;
  hud: (phase: 'idle'|'reading'|'planning'|'tool'|'drafting'|'waiting', label?: string, p?: number) => void;
  newId: (prefix?: string) => string;
  readAttachment: (name: string) => Promise<{ mimeType: string; bytes: string } | null>;
  config?: Cfg;
  otherAgentId?: string;
  model?: string;
  llm: LlmProvider;
};

export type ReadableHashPayload = {
  agentCardUrl?: string;
  mcpUrl?: string;
  llm?: { provider?: 'server'|'client-openai'; model?: string; baseUrl?: string };
  planner?: { id?: 'off'|'llm-drafter'|'scenario-v0.3'|'simple-demo'; mode?: 'approve'|'auto'; seed?: any };
  planners?: Record<string, { seed: any }>;
  rev?: number;
};

export type Planner<Cfg = unknown> = {
  id: string;
  name: string;
  plan(input: PlanInput, ctx: PlanContext<Cfg>): Promise<ProposedFact[]> | ProposedFact[];

  // Config management (optional - for planners with configuration)
  createConfigStore?: (opts: {
    llm: any;
    initialValues?: Record<string, unknown>;
    onConfigChange?: (config: any) => void;
  }) => import('../frontend/planner/config/types').PlannerConfigStore;

  dehydrate?: (config: Cfg) => Record<string, unknown>;
  hydrate?: (seed: Record<string, unknown>, context: any) => Promise<{ config: Cfg; ready: boolean }>;

  // Optional: provide a peer setup payload for constructing counterpart URLs using readable-hash schema
  makePeerSetup?: (opts: { fullConfig: Cfg; facts?: ReadonlyArray<Fact>; mode?: 'approve'|'auto' }) => ReadableHashPayload | null;
};
