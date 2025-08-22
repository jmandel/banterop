// src/frontend/client/types/events.ts
// Unified strict event types for planner + UI

export type Channel = 'user-planner' | 'planner-agent' | 'system' | 'tool' | 'status';
export type MsgAuthor = 'user' | 'planner' | 'agent' | 'system';
export type EventType = 'message' | 'tool_call' | 'tool_result' | 'read_attachment' | 'status' | 'trace';

export type AttachmentLite = { name: string; mimeType: string; bytes?: string; uri?: string };

// ⬇️ Add optional finality so the planner can request a conversation close.
export type MessagePayload = {
  text: string; // non-empty
  attachments?: AttachmentLite[];
  finality?: 'none' | 'turn' | 'conversation';
};

export type ToolCallPayload = { name: string; args: Record<string, unknown> };
export type ToolResultPayload = { result: unknown };
export type ReadAttachmentPayload = {
  name: string;
  ok: boolean;
  size?: number;
  truncated?: boolean;
  text_excerpt?: string;
};
export type StatusPayload = {
  state: 'initializing'|'submitted'|'working'|'input-required'|'completed'|'failed'|'canceled';
};
export type TracePayload = { text: string };

export type PayloadByType = {
  message: MessagePayload;
  tool_call: ToolCallPayload;
  tool_result: ToolResultPayload;
  read_attachment: ReadAttachmentPayload;
  status: StatusPayload;
  trace: TracePayload;
};

export type UnifiedEvent<T extends EventType = EventType> = {
  seq: number;
  timestamp: string; // ISO 8601
  type: T;
  channel: Channel;
  author: MsgAuthor;
  payload: PayloadByType[T];
  // Optional reasoning associated with planner LLM decisions leading to this event
  reasoning?: string;
};

function isObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
function nonEmptyString(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

export function assertEvent(e: UnifiedEvent): asserts e is UnifiedEvent {
  // seq
  if (typeof e.seq !== 'number' || !Number.isInteger(e.seq) || e.seq <= 0) {
    throw new Error(`Event invariant violated: seq must be positive integer (got ${e.seq})`);
  }
  // timestamp
  if (!nonEmptyString(e.timestamp) || Number.isNaN(Date.parse(e.timestamp))) {
    throw new Error(`Event invariant violated: invalid ISO timestamp (got ${e.timestamp})`);
  }
  // enums
  const allowedTypes: EventType[] = ['message','tool_call','tool_result','read_attachment','status','trace'];
  if (!allowedTypes.includes(e.type)) {
    throw new Error(`Event invariant violated: unknown type "${(e as any).type}"`);
  }
  const allowedChannels: Channel[] = ['user-planner','planner-agent','system','tool','status'];
  if (!allowedChannels.includes(e.channel)) {
    throw new Error(`Event invariant violated: unknown channel "${(e as any).channel}"`);
  }
  const allowedAuthors: MsgAuthor[] = ['user','planner','agent','system'];
  if (!allowedAuthors.includes(e.author)) {
    throw new Error(`Event invariant violated: unknown author "${(e as any).author}"`);
  }

  // channel/author constraints
  const okPair = (
    (e.channel === 'user-planner' && (e.author === 'user' || e.author === 'planner')) ||
    (e.channel === 'planner-agent' && (e.author === 'planner' || e.author === 'agent')) ||
    (e.channel === 'system' && e.author === 'system') ||
    (e.channel === 'tool' && (e.author === 'planner' || e.author === 'system')) ||
    (e.channel === 'status' && e.author === 'system')
  );
  if (!okPair) {
    throw new Error(`Event invariant violated: invalid channel/author pair ${e.channel}::${e.author}`);
  }

  // type-specific checks (including channel constraints)
  switch (e.type) {
    case 'message': {
      if (!(e.channel === 'user-planner' || e.channel === 'planner-agent')) {
        throw new Error(`Event invariant violated: message must be on 'user-planner' or 'planner-agent'`);
      }
      const p = e.payload as MessagePayload;
      if (!nonEmptyString(p.text)) {
        throw new Error(`Event invariant violated: message.payload.text must be non-empty`);
      }
      if (p.attachments !== undefined) {
        if (!Array.isArray(p.attachments)) throw new Error(`Event invariant violated: message.payload.attachments must be an array`);
        for (const a of p.attachments) {
          if (!isObject(a) || !nonEmptyString((a as any).name) || !nonEmptyString((a as any).mimeType)) {
            throw new Error(`Event invariant violated: attachment must include non-empty name and mimeType`);
          }
          if (a.bytes !== undefined && typeof a.bytes !== 'string') throw new Error(`Event invariant violated: attachment.bytes must be base64 string`);
          if (a.uri !== undefined && typeof a.uri !== 'string') throw new Error(`Event invariant violated: attachment.uri must be string`);
        }
      }
      if (p.finality !== undefined && !['none','turn','conversation'].includes(p.finality)) {
        throw new Error(`Event invariant violated: message.payload.finality invalid (${(p as any).finality})`);
      }
      break;
    }
    case 'tool_call': {
      if (e.channel !== 'tool') throw new Error(`Event invariant violated: tool_call must be on 'tool' channel`);
      const p = e.payload as ToolCallPayload;
      if (!nonEmptyString(p.name)) throw new Error(`Event invariant violated: tool_call.payload.name must be non-empty`);
      if (!isObject(p.args)) throw new Error(`Event invariant violated: tool_call.payload.args must be object`);
      break;
    }
    case 'tool_result': {
      if (e.channel !== 'tool') throw new Error(`Event invariant violated: tool_result must be on 'tool' channel`);
      const p = e.payload as ToolResultPayload;
      if (!('result' in p)) throw new Error(`Event invariant violated: tool_result.payload.result must exist`);
      break;
    }
    case 'read_attachment': {
      if (e.channel !== 'tool') throw new Error(`Event invariant violated: read_attachment must be on 'tool' channel`);
      const p = e.payload as ReadAttachmentPayload;
      if (!nonEmptyString(p.name)) throw new Error(`Event invariant violated: read_attachment.payload.name must be non-empty`);
      if (typeof p.ok !== 'boolean') throw new Error(`Event invariant violated: read_attachment.payload.ok must be boolean`);
      if (p.size !== undefined && typeof p.size !== 'number') throw new Error(`Event invariant violated: read_attachment.payload.size must be number`);
      if (p.truncated !== undefined && typeof p.truncated !== 'boolean') throw new Error(`Event invariant violated: read_attachment.payload.truncated must be boolean`);
      if (p.text_excerpt !== undefined && typeof p.text_excerpt !== 'string') throw new Error(`Event invariant violated: read_attachment.payload.text_excerpt must be string`);
      break;
    }
    case 'status': {
      if (!(e.channel === 'status' && e.author === 'system')) {
        throw new Error(`Event invariant violated: status must be on 'status' channel by 'system'`);
      }
      const p = e.payload as StatusPayload;
      const allowed: StatusPayload['state'][] = ['initializing','submitted','working','input-required','completed','failed','canceled'];
      if (!allowed.includes(p.state)) {
        throw new Error(`Event invariant violated: status.payload.state invalid (${(p as any).state})`);
      }
      break;
    }
    case 'trace': {
      if (!(e.channel === 'system' && e.author === 'system')) {
        throw new Error(`Event invariant violated: trace must be on 'system' channel by 'system'`);
      }
      const p = e.payload as TracePayload;
      if (!nonEmptyString(p.text)) {
        throw new Error(`Event invariant violated: trace.payload.text must be non-empty`);
      }
      break;
    }
  }
}

// Factory: assigns seq + timestamp, then validates.
export function makeEvent<T extends EventType>(
  nextSeq: number,
  partial: Omit<UnifiedEvent<T>, 'seq' | 'timestamp'>
): UnifiedEvent<T> {
  const ev = { ...partial, seq: nextSeq, timestamp: new Date().toISOString() } as UnifiedEvent<T>;
  assertEvent(ev);
  return ev;
}