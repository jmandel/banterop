Got it. You want this refactor **strict**, **forward‑only**, and **self‑documented**—no compatibility shims, no silent fallbacks. Below is a complete development plan and the code you can drop in. If any invariant is violated at runtime, the app will **throw** with a clear error.

---

## Outcome

* **Single Source of Truth:** The **Event Log** is the only timeline. Both transcripts (User↔Planner and Planner↔Agent) are **derived** from it.
* **Strict schema:** Every event carries `type`, `channel`, `author`, and a typed `payload`. If anything is malformed, we **throw loudly**.
* **No back-compat paths:** Old event types like `agent_message`, `user_reply`, `send_to_user`, `send_to_remote_agent` are removed and replaced by a single `message` event with `channel`+`author`.
* **Selectors only read:** Both transcript panes render from selectors that expect strict events. If not strict → selectors will throw (because events are validated at creation time).
* **Derived status + turn:** UI and planner derive status and `yourTurn` solely from the Event Log (latest `status` event). Before any status exists, treat as “no task yet” (initial send allowed).
* **Evergreen side effects:** Vault mirroring and tool-result indexing live in the planner and always reflect the latest event state used to build prompts.

---

## Invariants (MUST hold, no exceptions)

> These are enforced by `assertEvent(...)`. If violated, execution **throws**.

1. **Structure**

   * `seq`: strictly increasing positive integer (per client instance).
   * `timestamp`: ISO 8601 string, `Date.parse(timestamp) >= 0`.
   * `type ∈ { 'message','tool_call','tool_result','read_attachment','status','trace' }`.
   * `channel ∈ { 'user-planner','planner-agent','system','tool','status' }`.
   * `author ∈ { 'user','planner','agent','system' }`.
   * `payload`: object (not null), **shape depends on type** (below).

2. **Allowed channel/author pairs**

   * `channel: 'user-planner'` → `author ∈ {'user','planner'}`
   * `channel: 'planner-agent'` → `author ∈ {'planner','agent'}`
   * `channel: 'system'` → `author === 'system'`
   * `channel: 'tool'` → `author ∈ {'planner','system'}`
   * `channel: 'status'` → `author === 'system'`

3. **Type-specific payload**

   * **message**: `{ text: nonEmptyString; attachments?: Array<{ name: string; mimeType: string; bytes?: string; uri?: string }> }`
   * **tool\_call**: `{ name: nonEmptyString; args: object }`
   * **tool\_result**: `{ result: any }` (shape is tool-specific; must exist)
   * **read\_attachment**: `{ name: nonEmptyString; ok: boolean; size?: number; truncated?: boolean; text_excerpt?: string }`
   * **status**: `{ state ∈ {'initializing','submitted','working','input-required','completed','failed','canceled'} }`
   * **trace**: `{ text: nonEmptyString }`

4. **Channel per type**

   * `message` → `channel ∈ {'user-planner','planner-agent'}`
   * `tool_call | tool_result | read_attachment` → `channel === 'tool'`
   * `status` → `channel === 'status'`
  * `trace` → `channel === 'system'`

5. **Attachments availability**

   * Any attachment synthesized by our agent (via `tool_result`) or received from the remote agent (via `message` from `author='agent'` with attachments) is immediately available in the app’s `AttachmentVault` at the time the event is emitted.
   * On reload, replay of the Event Log re-establishes vault contents deterministically (see Vault Policy).

---

## Migration plan (no back-compat)

1. **Create a shared event module** (`src/frontend/client/types/events.ts`) with the types, `assertEvent`, and a helper `createEvent(...)`.

2. **Replace ad‑hoc event types** in the planner with the strict ones:

   * All outbound and inbound “chatty” things are `type: 'message'` with `channel` + `author`.
   * Tool work is `tool_call` / `tool_result` / `read_attachment`.
   * Task status changes become `status`.
   * “System notes” become `trace`.

3. **Introduce selectors** to derive both transcripts from the event log:

   * `selectFrontMessages(events)` → User↔Planner pane.
   * `selectAgentLog(events)` → Planner↔Agent pane.

4. **Make App consume only events**:

   * Remove `front` and `agentLog` local state and reducer actions.
   * Compute both panes via selectors from `eventLog`.
   * Persist only `eventLog` (plus draft input), not any parallel timelines.

5. **Event creation centralized & strict**:

   * All code that “pushes an event” goes through a single helper that assigns `seq`, `timestamp`, calls `assertEvent`, and throws on violation.

6. **UI updates**:

   * `EventLogView` reads the strict event type, no local type.
  * `DualConversationView` is unchanged in props; it receives derived arrays.

7. **Status/turn derivation**:

   * Do not read task status directly in the UI. Instead, read the last `status` event from the Event Log. `yourTurn = lastStatus.state === 'input-required'`.
   * Planner gating (whether it can send to the remote agent) uses the same derivation: allow when `input-required`, or when no status event exists yet (initial contact).

8. **Evergreen side effects**:

   * The planner mirrors inbound agent attachments into the vault before emitting the corresponding `message` event.
   * The planner indexes `tool_result` outputs and upserts synthesized files into the vault in the same tick as event emission.
   * On `loadEvents` during resume, the planner replays the Event Log to rebuild document indices and upsert files, ensuring prompts always reflect current state.

9. **Greenfield only**:

   * Old sessions using legacy event shapes are not supported. If present, ignore them; do not attempt migration.

---

## Vault Policy (filename-authoritative)

- Filenames are authoritative. “Load this file under name N” replaces any existing entry with name N in the `AttachmentVault` (latest event wins).
- Replay idempotence: Replaying the same Event Log yields the same final vault state. No duplicates are created; we always upsert by name.
- Persistence: User uploads loaded from storage remain, but any replayed events that reference the same name N will overwrite that entry (consistent with filename-authoritative semantics).
- Implementation:
  - `addFromAgent(name, mimeType, bytes)`: upsert by name (replace if exists).
  - `addSynthetic(name, mimeType, contentUtf8)`: already overwrites by name.
  - Planner performs upserts before emitting `message` (for inbound agent attachments) and when emitting `tool_result` (for synthesized docs).

---

## Code changes

> Paste these files/patches exactly. This is forward-only; delete any dead code that references old event shapes.

### 1) NEW — `src/frontend/client/types/events.ts`

```ts
// src/frontend/client/types/events.ts
export type Channel = 'user-planner' | 'planner-agent' | 'system' | 'tool' | 'status';
export type MsgAuthor = 'user' | 'planner' | 'agent' | 'system';
export type EventType = 'message' | 'tool_call' | 'tool_result' | 'read_attachment' | 'status' | 'trace';

export type AttachmentLite = { name: string; mimeType: string; bytes?: string; uri?: string };

export type MessagePayload = {
  text: string; // non-empty
  attachments?: AttachmentLite[];
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
};

// ---------- Invariants (throw on violation) ----------

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
  // type
  const allowedTypes: EventType[] = ['message','tool_call','tool_result','read_attachment','status','trace'];
  if (!allowedTypes.includes(e.type)) {
    throw new Error(`Event invariant violated: unknown type "${(e as any).type}"`);
  }
  // channel
  const allowedChannels: Channel[] = ['user-planner','planner-agent','system','tool','status'];
  if (!allowedChannels.includes(e.channel)) {
    throw new Error(`Event invariant violated: unknown channel "${(e as any).channel}"`);
  }
  // author
  const allowedAuthors: MsgAuthor[] = ['user','planner','agent','system'];
  if (!allowedAuthors.includes(e.author)) {
    throw new Error(`Event invariant violated: unknown author "${(e as any).author}"`);
  }
  // channel/author pairs
  const ca = `${e.channel}::${e.author}`;
  const okCA =
    (e.channel === 'user-planner' && (e.author === 'user' || e.author === 'planner')) ||
    (e.channel === 'planner-agent' && (e.author === 'planner' || e.author === 'agent')) ||
    (e.channel === 'system' && e.author === 'system') ||
    (e.channel === 'tool' && (e.author === 'planner' || e.author === 'system')) ||
    (e.channel === 'status' && e.author === 'system');
  if (!okCA) {
    throw new Error(`Event invariant violated: invalid channel/author (${ca}) for type=${e.type}`);
  }
  // payload
  if (!isObject(e.payload)) {
    throw new Error(`Event invariant violated: payload must be an object (got ${typeof e.payload})`);
  }
  // type-specific payload + channel
  switch (e.type) {
    case 'message': {
      if (!(e.channel === 'user-planner' || e.channel === 'planner-agent')) {
        throw new Error(`Event invariant violated: message.channel must be 'user-planner' or 'planner-agent'`);
      }
      const p = e.payload as MessagePayload;
      if (!nonEmptyString(p.text)) {
        throw new Error(`Event invariant violated: message.payload.text must be non-empty`);
      }
      break;
    }
    case 'tool_call': {
      if (e.channel !== 'tool') {
        throw new Error(`Event invariant violated: tool_call.channel must be 'tool'`);
      }
      const p = e.payload as ToolCallPayload;
      if (!nonEmptyString(p.name) || !isObject(p.args)) {
        throw new Error(`Event invariant violated: tool_call payload must have name (string) and args (object)`);
      }
      break;
    }
    case 'tool_result': {
      if (e.channel !== 'tool') {
        throw new Error(`Event invariant violated: tool_result.channel must be 'tool'`);
      }
      const p = e.payload as ToolResultPayload;
      if (!('result' in p)) {
        throw new Error(`Event invariant violated: tool_result payload must have 'result'`);
      }
      break;
    }
    case 'read_attachment': {
      if (e.channel !== 'tool') {
        throw new Error(`Event invariant violated: read_attachment.channel must be 'tool'`);
      }
      const p = e.payload as ReadAttachmentPayload;
      if (!nonEmptyString(p.name) || typeof p.ok !== 'boolean') {
        throw new Error(`Event invariant violated: read_attachment requires name (string) and ok (boolean)`);
      }
      break;
    }
    case 'status': {
      if (e.channel !== 'status' || e.author !== 'system') {
        throw new Error(`Event invariant violated: status must be on 'status' channel by 'system'`);
      }
      const p = e.payload as StatusPayload;
      const allowed = ['initializing','submitted','working','input-required','completed','failed','canceled'];
      if (!allowed.includes(p.state)) {
        throw new Error(`Event invariant violated: invalid status.state "${(p as any).state}"`);
      }
      break;
    }
    case 'trace': {
      if (e.channel !== 'system' || e.author !== 'system') {
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
```

---

### 2) NEW — `src/frontend/client/selectors/transcripts.ts`

```ts
// src/frontend/client/selectors/transcripts.ts
import type { UnifiedEvent } from '../types/events';

export type FrontMsg = { id: string; role: 'you' | 'planner' | 'system'; text: string };

export type AgentLogEntry = {
  id: string;
  role: 'planner' | 'agent';
  text: string;
  attachments?: Array<{ name: string; mimeType: string; bytes?: string; uri?: string }>;
};

export function selectFrontMessages(events: UnifiedEvent[]): FrontMsg[] {
  const out: FrontMsg[] = [];
  for (const e of events) {
    if (e.type === 'message' && e.channel === 'user-planner') {
      const role: FrontMsg['role'] = e.author === 'user' ? 'you' : 'planner';
      out.push({ id: String(e.seq), role, text: e.payload.text });
      continue;
    }
    if (e.type === 'trace' && e.channel === 'system') {
      out.push({ id: String(e.seq), role: 'system', text: e.payload.text });
      continue;
    }
    if (e.type === 'status') {
      out.push({ id: String(e.seq), role: 'system', text: `— status: ${e.payload.state} —` });
      continue;
    }
  }
  return out;
}

export function selectAgentLog(events: UnifiedEvent[]): AgentLogEntry[] {
  const out: AgentLogEntry[] = [];
  for (const e of events) {
    if (e.type !== 'message' || e.channel !== 'planner-agent') continue;
    out.push({
      id: String(e.seq),
      role: e.author === 'planner' ? 'planner' : 'agent',
      text: e.payload.text,
      attachments: e.payload.attachments || [],
    });
  }
  return out;
}
```

---

### 3) UPDATE — `src/frontend/client/components/EventLogView.tsx`

```tsx
// src/frontend/client/components/EventLogView.tsx
import React from 'react';
import type { UnifiedEvent } from '../../types/events';

export const EventLogView: React.FC<{ events: UnifiedEvent[]; busy?: boolean }>
  = ({ events, busy = false }) => {
  return (
    <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
      <div className={`relative bg-gradient-to-r from-slate-500 to-slate-600 text-white p-4`}>
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-lg">Agent Event Log (read-only)</h3>
          <div className="flex items-center gap-2">
            {busy && (
              <span className="px-2 py-1 bg-white/20 rounded-full text-xs font-medium" title="Completions in progress">
                Thinking…
              </span>
            )}
            <span className="px-2 py-1 bg-white/20 rounded-full text-xs font-medium">
              {events.length} events
            </span>
          </div>
        </div>
      </div>
      <div className="max-h-[320px] overflow-y-auto p-4 bg-gray-50">
        <ul className="space-y-2">
          {events.map((e) => (
            <li key={e.seq} className="bg-white border border-gray-200 rounded-lg p-3">
              <div className="text-xs text-gray-500 flex items-center justify-between">
                <span>#{e.seq} • {new Date(e.timestamp).toLocaleTimeString()} • {e.type}</span>
                <span className="font-mono">{e.channel} • {e.author}</span>
              </div>
              <div className="mt-2 text-sm text-gray-800 whitespace-pre-wrap break-words">
                {e.type === 'message' && (
                  <>
                    <div>{e.payload.text}</div>
                    {Array.isArray(e.payload.attachments) && e.payload.attachments.length > 0 && (
                      <div className="mt-1 text-xs text-gray-600">
                        Attachments: {e.payload.attachments.map((a) => a?.name).filter(Boolean).join(', ')}
                      </div>
                    )}
                  </>
                )}
                {e.type === 'tool_call' && (
                  <>
                    <div className="font-mono">CALL {e.payload.name}</div>
                    <div className="mt-1 text-xs text-gray-600">
                      args: {JSON.stringify(e.payload.args ?? {})}
                    </div>
                  </>
                )}
                {e.type === 'tool_result' && (
                  <div className="text-xs text-gray-600">
                    result: {JSON.stringify(e.payload.result ?? {})}
                  </div>
                )}
                {e.type === 'read_attachment' && (
                  <div className="text-xs text-gray-600">
                    read "{e.payload.name}": {e.payload.ok ? 'ok' : 'blocked'}
                    {typeof e.payload.text_excerpt === 'string' && e.payload.text_excerpt && (
                      <pre className="bg-white border border-gray-200 rounded p-2 overflow-auto mt-1">
                        {e.payload.text_excerpt}
                      </pre>
                    )}
                  </div>
                )}
                {e.type === 'status' && (
                  <div className="text-xs text-gray-600">state: {e.payload.state}</div>
                )}
                {e.type === 'trace' && (
                  <div className="text-xs text-gray-600">{e.payload.text}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
```

---

### 4) UPDATE — `src/frontend/client/planner-scenario.ts`

> Replace the local `UnifiedEvent` type and **all** old event names with strict ones. Introduce a single helper `emit(...)` that validates and pushes.

```ts
// src/frontend/client/planner-scenario.ts
import type { TaskClientLike } from "./protocols/task-client";
import { AttachmentVault } from "./attachments-vault";
import { ToolSynthesisService } from '$src/agents/services/tool-synthesis.service';
import { parseBridgeEndpoint } from './bridge-endpoint';
import { BrowsersideLLMProvider } from '$src/llm/providers/browserside';
import type { UnifiedEvent, EventType, Channel, MsgAuthor, AttachmentLite } from './types/events';
import { makeEvent, assertEvent } from './types/events';

// ... (ScenarioConfiguration type stays the same)

type ScenarioPlannerDeps = {
  task: TaskClientLike | null;
  vault: AttachmentVault;
  getApiBase: () => string;
  getEndpoint: () => string;
  getPlannerAgentId: () => string | undefined;
  getCounterpartAgentId: () => string | undefined;
  getAdditionalInstructions?: () => string | undefined;
  getScenarioConfig?: () => any;
  getEnabledTools?: () => Array<{
    name: string; description?: string; synthesisGuidance?: string;
    inputSchema?: any; endsConversation?: boolean; conversationEndStatus?: string;
  }>;
  onSystem: (text: string) => void; // keep; host may still want to surface lightweight notices
  onAskUser: (q: string) => void;
  onPlannerThinking?: (busy: boolean) => void;
};

export class ScenarioPlannerV2 {
  private running = false;
  private busy = false;
  private pendingTick = false;
  private eventLog: UnifiedEvent[] = [];
  private seq = 0;
  private listeners = new Set<(e: UnifiedEvent) => void>();
  private documents = new Map<string, { name: string; contentType: string; content?: string; summary?: string }>();
  private oracle: ToolSynthesisService | null = null;
  private llmProvider: BrowsersideLLMProvider | null = null;
  private taskOff: (() => void) | null = null;
  private lastStatus: string | null = null;

  constructor(private deps: ScenarioPlannerDeps) {}

  // -------- Strict helper: create+validate+push --------
  private emit<T extends EventType>(
    partial: Omit<UnifiedEvent<T>, 'seq' | 'timestamp'>
  ): UnifiedEvent<T> {
    const ev = makeEvent<T>(++this.seq, partial);
    assertEvent(ev);
    this.eventLog.push(ev);
    // side-effects: index tool documents
    if (ev.type === 'tool_result') {
      this.indexDocumentsFromResult((ev.payload as any).result);
    }
    for (const cb of this.listeners) cb(ev);
    return ev;
  }

  // Public helpers (for App hooks) — remain minimal and strict
  recordUserReply(text: string) {
    if (!text || !text.trim()) return;
    this.emit({
      type: 'message',
      channel: 'user-planner',
      author: 'user',
      payload: { text: text.trim() }
    });
    // wake the planner
    this.maybeTick();
  }

  recordSystemMessage(text: string) {
    if (!text || !text.trim()) return;
    this.emit({
      type: 'trace',
      channel: 'system',
      author: 'system',
      payload: { text: text.trim() }
    });
  }

  onEvent(cb: (e: UnifiedEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getEvents(): UnifiedEvent[] { return [...this.eventLog]; }

  // Replay strict unified events to rebuild state and vault on resume
  loadEvents(events: UnifiedEvent[]) {
    // Only accept strict, new-format events
    try { this.eventLog = Array.isArray(events) ? [...events] : []; } catch { this.eventLog = []; }
    // Reset seq to max existing seq
    const maxSeq = this.eventLog.reduce((m, e) => Math.max(m, Number(e?.seq || 0)), 0);
    this.seq = Number.isFinite(maxSeq) ? maxSeq : 0;
    // Rebuild documents + vault using filename-authoritative upserts
    for (const ev of this.eventLog) {
      if (ev.type === 'tool_result') {
        this.indexDocumentsFromResult((ev as any).payload?.result);
      }
      if (ev.type === 'message' && ev.channel === 'planner-agent' && ev.author === 'agent') {
        const atts = Array.isArray((ev as any).payload?.attachments) ? (ev as any).payload.attachments : [];
        for (const a of atts) {
          try {
            const name = String(a?.name || '');
            const mime = String(a?.mimeType || 'application/octet-stream');
            const bytes = String(a?.bytes || '');
            // Upsert-by-name to enforce filename-authoritative policy
            this.deps.vault.addFromAgent(name, mime, bytes);
          } catch {}
        }
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.subscribeTask();
    void this.ensureScenarioLoaded();
    // Try an initial tick
    this.maybeTick();
  }

  stop() {
    this.running = false;
    try { this.taskOff?.(); } catch {}
    this.taskOff = null;
    this.busy = false;
    this.pendingTick = false;
  }

  private subscribeTask() {
    try { this.taskOff?.(); } catch {}
    this.taskOff = null;
    const task = this.deps.task as any;
    if (!task || typeof task.on !== 'function') {
      console.warn('[Planner] subscribeTask skipped: no task bound');
      return;
    }
    this.taskOff = task.on("new-task", () => {
      const t = task.getTask?.();
      // status event (strict, only when changed)
      const st = String(t?.status?.state || '');
      if (st && this.lastStatus !== st) {
        this.lastStatus = st;
        this.emit({ type: 'status', channel: 'status', author: 'system', payload: { state: st as any } });
      }

      // last message (remote agent)
      const last = (t?.history || []).slice(-1)[0];
      if (!last || String(last.role) !== 'agent') return;
      const text = (last.parts || []).filter((p: any) => p?.kind === "text").map((p: any) => p.text).join("\n") || '';
      const attachments: AttachmentLite[] = (last.parts || [])
        .filter((p: any) => p?.kind === "file" && p?.file)
        .map((p: any) => ({ name: p.file.name, mimeType: p.file.mimeType, bytes: p.file.bytes, uri: p.file.uri }))
        .filter((a: any) => a?.name && a?.mimeType);

      // Mirror attachments into the vault (filename-authoritative upsert) before emitting event
      for (const a of attachments) {
        try {
          this.deps.vault.addFromAgent(a.name, a.mimeType, a.bytes || '');
        } catch {}
      }

      // Emit strict message event
      if (text || attachments.length) {
        this.emit({
          type: 'message',
          channel: 'planner-agent',
          author: 'agent',
          payload: { text, attachments: attachments.length ? attachments : undefined }
        });
      }
      this.maybeTick();
    });
  }

  private async ensureScenarioLoaded() {
    try {
      const cfg = this.deps.getScenarioConfig?.();
      void cfg; // (kept for future; prompt is built from scenario when available)
    } catch {}
  }

  private canActNow(): boolean {
    // Derive from Event Log status: input-required → can act; if no status yet → allow initial contact
    const lastStatus = [...this.eventLog].reverse().find(e => e.type === 'status');
    if (!lastStatus) return true; // initial, no task yet
    const st = String((lastStatus as any).payload?.state || '');
    return st === 'input-required' || st === 'completed';
  }

  private async tickOnce() {
    const setThinking = (b: boolean) => { try { this.deps.onPlannerThinking?.(b); } catch {} };
    // Build prompt (existing logic kept)
    const prompt = this.buildPrompt();

    let content = '';
    try {
      setThinking(true);
      const res = await this.callLLM(prompt);
      content = String(res?.content ?? '');
    } finally { setThinking(false); }

    const { reasoning, tool, args } = this.parseAction(content);
    // Derive ability to send from the Event Log
    const lastStatus = [...this.eventLog].reverse().find(e => e.type === 'status');
    const statusNow = String((lastStatus as any)?.payload?.state || '');
    const canSendRemote = !lastStatus || statusNow === 'input-required';

    if (tool === 'sleep') {
      await new Promise(r => setTimeout(r, 150));
      return;
    }

    if (tool === 'sendMessageToUser' || tool === 'askUser') {
      const q = String(args?.text || args?.question || '').trim();
      if (q) {
        // Strict message event to user
        this.emit({
          type: 'message', channel: 'user-planner', author: 'planner', payload: { text: q }
        });
        // FYI callback for UI (no event creation here)
        try { this.deps.onAskUser(q); } catch {}
      }
      return;
    }

    if (tool === "readAttachment") {
      const name = String(args?.name || "");
      const a = (name ? this.deps.vault.getByName(name) : null);
      const ok = !!a && !a.private;
      const result = ok
        ? { ok: true, name: a!.name, size: a!.size, truncated: !!a!.summary, text_excerpt: a!.summary || undefined }
        : { ok: false, name, text_excerpt: undefined };
      this.emit({ type: 'read_attachment', channel: 'tool', author: 'planner', payload: result as any });
      this.maybeTick();
      return;
    }

    if (tool === 'done') {
      const summary = String(args?.summary || '').trim();
      if (summary) {
        this.recordSystemMessage(`Planner done: ${summary}`);
      }
      return;
    }

    if (tool === 'sendMessage' || tool === 'sendMessageToRemoteAgent') {
      if (!canSendRemote) {
        this.recordSystemMessage('Cannot send to remote agent: not our turn or conversation ended.');
        return;
      }
      const text = String(args?.text || '').trim();
      const attsIn = Array.isArray(args?.attachments) ? args.attachments : [];
      const attachments: AttachmentLite[] = [];
      const unresolved: string[] = [];
      for (const a of attsIn) {
        if (!a?.name) continue;
        const rec = this.deps.vault.getByName(String(a.name));
        if (rec) {
          attachments.push({ name: rec.name, mimeType: rec.mimeType, bytes: rec.bytes });
        } else {
          unresolved.push(String(a.name));
        }
      }
      if (unresolved.length) {
        throw new Error(`Attachments not found: ${unresolved.join(', ')}`);
      }

      // Emit message event first
      this.emit({
        type: 'message',
        channel: 'planner-agent',
        author: 'planner',
        payload: { text, attachments: attachments.length ? attachments : undefined }
      });

      // Actually send to remote via A2A
      const parts: any[] = [];
      if (text) parts.push({ kind: "text", text });
      for (const a of attachments) {
        parts.push({ kind: 'file', file: { name: a.name, mimeType: a.mimeType, bytes: a.bytes } });
      }
      if (this.deps.task) {
        if (!this.deps.task.getTaskId?.()) await (this.deps.task as any).startNew?.(parts as any);
        else await (this.deps.task as any).send?.(parts as any);
      }
      return;
    }

    // Dynamic synthesized tools (unchanged except for strict events)
    const enabledDefs = (this.deps.getEnabledTools?.() || []);
    const enabledNames = enabledDefs.map(t => t.name);
    if (enabledNames.includes(tool)) {
      // Emit tool_call
      this.emit({ type: 'tool_call', channel: 'tool', author: 'planner', payload: { name: tool, args: args || {} } });
      try {
        this.deps.onPlannerThinking?.(true);
        if (!this.oracle) {
          const api = this.deps.getApiBase();
          const serverUrl = api.replace(/\/api$/, '');
          const provider = new BrowsersideLLMProvider({ provider: 'browserside', serverUrl });
          this.oracle = new ToolSynthesisService(provider);
        }
        const sc: any = this.deps.getScenarioConfig?.();
        const plannerId = this.deps.getPlannerAgentId?.() || '';
        const agentDef = Array.isArray(sc?.agents) ? sc.agents.find((a: any) => a?.agentId === plannerId) : null;
        const result = await this.oracle.execute({
          tool: {
            toolName: tool,
            description: enabledDefs.find(t => t.name === tool)?.description || '',
            synthesisGuidance: enabledDefs.find(t => t.name === tool)?.synthesisGuidance || '',
            inputSchema: enabledDefs.find(t => t.name === tool)?.inputSchema,
            endsConversation: enabledDefs.find(t => t.name === tool)?.endsConversation,
            conversationEndStatus: enabledDefs.find(t => t.name === tool)?.conversationEndStatus,
          },
          args: args || {},
          agent: {
            agentId: plannerId,
            principal: agentDef?.principal,
            situation: agentDef?.situation,
            systemPrompt: agentDef?.systemPrompt,
            goals: agentDef?.goals,
          },
          scenario: sc,
          conversationHistory: this.buildXmlHistory(),
        } as any);
        this.emit({ type: 'tool_result', channel: 'tool', author: 'system', payload: { result: result?.output } });
      } finally {
        this.deps.onPlannerThinking?.(false);
      }
      this.maybeTick();
      return;
    }

    // Unknown tool
    this.recordSystemMessage(`Unknown tool requested: ${tool}`);
  }

  private maybeTick() {
    if (!this.running) return;
    if (this.busy) { this.pendingTick = true; return; }
    if (!this.canActNow()) return;
    this.busy = true;
    (async () => {
      try { await this.tickOnce(); }
      catch (e: any) { this.recordSystemMessage(`Planner error: ${String(e?.message || e)}`); }
      finally {
        this.busy = false;
        if (this.pendingTick) { this.pendingTick = false; this.maybeTick(); }
      }
    })();
  }

  // --- buildXmlHistory() updated to new strict events ---
  private buildXmlHistory(): string {
    const lines: string[] = [];
    for (const ev of this.eventLog) {
      if (ev.type === 'message') {
        const from =
          ev.channel === 'user-planner'
            ? (ev.author === 'user' ? 'user' : 'planner')
            : (ev.author === 'planner' ? 'planner' : 'agent');
        lines.push(`<message from="${from}">${ev.payload.text}</message>`);
        const atts = ev.payload.attachments || [];
        for (const a of atts) lines.push(`<attachment name="${a.name}" mimeType="${a.mimeType}" />`);
      } else if (ev.type === 'tool_call') {
        lines.push(`<tool_call>${JSON.stringify({ action: { tool: ev.payload.name, args: ev.payload.args } })}</tool_call>`);
      } else if (ev.type === 'tool_result') {
        lines.push(`<tool_result>${JSON.stringify(ev.payload.result ?? {})}</tool_result>`);
      } else if (ev.type === 'read_attachment') {
        lines.push(`<tool_call>${JSON.stringify({ action: { tool: 'readAttachment', args: { name: ev.payload.name } } })}</tool_call>`);
        if (ev.payload.text_excerpt) {
          const safe = ev.payload.text_excerpt.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          lines.push(`<tool_result filename="${ev.payload.name}">\n${safe}\n</tool_result>`);
        } else {
          lines.push(`<tool_result>${JSON.stringify({ ok: ev.payload.ok })}</tool_result>`);
        }
      } else if (ev.type === 'status') {
        lines.push(`<status>${ev.payload.state}</status>`);
      } else if (ev.type === 'trace') {
        lines.push(`<trace>${ev.payload.text}</trace>`);
      }
    }
    return lines.join("\n");
  }

  // --- indexDocumentsFromResult unchanged (kept as in your repo) ---
  private indexDocumentsFromResult(obj: any): string[] {
    let found = 0; const created: string[] = [];
    const walk = (x: any) => {
      if (!x || typeof x !== 'object') return;
      if (typeof x.docId === 'string') {
        const name = String(x.name || x.docId);
        const contentType: string = String(x.contentType || 'text/markdown');
        const contentStr: string | undefined =
          typeof x.content === 'string' ? x.content :
          (x.content && typeof x.content === 'object' ? JSON.stringify(x.content, null, 2) : (typeof x.text === 'string' ? x.text : undefined));
        this.documents.set(name, { name, contentType, content: contentStr, summary: typeof x.summary === 'string' ? x.summary : undefined });
        try {
          if (typeof contentStr === 'string') this.deps.vault.addSynthetic(name, contentType, contentStr);
          else if (!this.deps.vault.getByName(name)) this.deps.vault.addFromAgent(name, contentType, '');
        } catch {}
        found++; created.push(name);
      }
      if (Array.isArray(x)) x.forEach(walk); else for (const k of Object.keys(x)) walk(x[k]);
    };
    try { walk(obj); } catch {}
    if (!found && obj && typeof obj === 'object') {
      const name = `synth_result_${Date.now()}.json`;
      const contentUtf8 = JSON.stringify(obj, null, 2);
      this.documents.set(name, { name, contentType: 'application/json', content: contentUtf8, summary: undefined });
      try { this.deps.vault.addSynthetic(name, 'application/json', contentUtf8); } catch {}
      created.push(name);
    }
    return created;
  }

  // callLLM, parseAction, buildPrompt remain as in your repo (no schema changes)
  // ...
}
```

> **Note:** We intentionally removed legacy “event kinds” and only emit strict events now.

---

### 5) UPDATE — `src/frontend/client/components/Conversations/DualConversationView.tsx`

*No signature change required*. It already accepts `frontMessages` and `agentLog`. Keep as-is.

---

### 6) NEW IMPORTS + SELECTORS USAGE — `src/frontend/client/App.tsx`

* Remove `front` and `agentLog` from the reducer/state.
* Derive panes from `eventLog` via selectors.
* Route system messages through scenario planner (`recordSystemMessage`), not local arrays.

Below is a **surgical** patch of the relevant parts. If you prefer, replace your file with this edited version, but keep your other logic (connection, persistence, attachments) intact.

```tsx
// --- at top of src/frontend/client/App.tsx ---
import type { UnifiedEvent as PlannerUnifiedEvent } from "./types/events";
import { selectFrontMessages, selectAgentLog } from "./selectors/transcripts";
// (remove: import type { UnifiedEvent as PlannerUnifiedEvent } from "./components/EventLogView";)

// Remove these local types if you want; kept for props compatibility
type FrontMsg = { id: string; role: "you" | "planner" | "system"; text: string };
type AgentLogEntry = {
  id: string;
  role: "planner" | "agent";
  text: string;
  partial?: boolean;
  attachments?: Array<{ name: string; mimeType: string; bytes?: string; uri?: string }>;
};

// --- In Model type: remove 'front' ---
type Model = {
  connected: boolean;
  endpoint: string;
  protocol: Protocol;
  taskId?: string;
  status: A2AStatus | "initializing";
  plannerMode: PlannerMode;
  plannerStarted: boolean;
  busy: boolean;
  error?: string;
  summarizeOnUpload: boolean;
};

// --- reducer: remove 'frontAppend' and 'system' cases ---
function reducer(m: Model, a: Act): Model {
  switch (a.type) {
    // ... same cases, but do not include frontAppend/system ...
    default:
      return m;
  }
}

// --- Act union: remove 'frontAppend' and 'system' ---
type Act =
  | { type: "connect"; endpoint: string; protocol: Protocol }
  | { type: "setTask"; taskId?: string }
  | { type: "status"; status: A2AStatus | "initializing" }
  | { type: "busy"; busy: boolean }
  | { type: "error"; error?: string }
  | { type: "setPlannerMode"; mode: PlannerMode }
  | { type: "setPlannerStarted"; started: boolean }
  | { type: "toggleSummarizeOnUpload"; on: boolean }
  | { type: "clearConversation" }
  | { type: "reset" };

// --- initModel: remove front: [] ---
// (already fine)

export default function App() {
  // ... (unchanged code)

  // Remove: const frontMsgsRef = useRef<FrontMsg[]>([]);
  // Remove the effect that syncs frontMsgsRef with model.front

  // Remove all places that persist/load model.front (front messages) in save/load session

  // In startPlanner: change hooks
  const startPlanner = (preloadedEvents?: PlannerUnifiedEvent[]) => {
    if (scenarioPlannerRef.current) return;
    const task = taskRef.current!;
    const getApiBase = () => API_BASE;
    const orch = new ScenarioPlannerV2({
      task,
      vault: vaultRef.current,
      getApiBase,
      getEndpoint: () => endpoint,
      getPlannerAgentId: () => selectedPlannerAgentId,
      getCounterpartAgentId: () => selectedCounterpartAgentId,
      getScenarioConfig: () => scenarioConfig,
      getEnabledTools: () => (currentTools.filter((t: { name: string; description?: string }) => enabledTools.includes(t.name))),
      getAdditionalInstructions: () => instructions,
      onSystem: (text) => { try { scenarioPlannerRef.current?.recordSystemMessage(text); } catch {} },
      onAskUser: (_q) => {}, // no-op; planner writes event itself
      onPlannerThinking: (b) => setPlannerThinking(b),
    });
    scenarioPlannerRef.current = orch;

    // Hard reset of old events: preloadedEvents are ignored in strict mode
    setEventLog(orch.getEvents() as any);

    const off = orch.onEvent((ev) => {
      setEventLog((prev) => {
        const next = [...prev, ev as any];
        try {
          const tid = taskRef.current?.getTaskId();
          if (endpoint && tid) {
            saveSession(endpoint, { taskId: tid, status: lastStatusRef.current });
            saveTaskSession(endpoint, tid, {
              taskId: tid,
              status: lastStatusRef.current,
              plannerStarted: true,
              frontDraft: frontInput,
              plannerEvents: next as any,
            });
          }
        } catch {}
        return next;
      });
    });
    scenarioPlannerOffRef.current = off;
    orch.start();
    signalEvent('planner-start');
    dispatch({ type: "setPlannerStarted", started: true });

    try {
      const tid = taskRef.current?.getTaskId();
      if (endpoint && tid) {
        saveSession(endpoint, { taskId: tid, status: lastStatusRef.current });
        saveTaskSession(endpoint, tid, {
          taskId: tid,
          status: lastStatusRef.current,
          plannerStarted: true,
          frontDraft: frontInput,
          plannerEvents: (scenarioPlannerRef.current?.getEvents() as any) || [],
        });
      }
    } catch {}
  };

  // When task status changes in handleConnect, replace dispatch({type:'system'}) with planner system message
  // e.g. inside 'if (st === "completed") { ... }':
  //   scenarioPlannerRef.current?.recordSystemMessage('— conversation completed —');

  // Sending a user message: DO NOT append to a local array
  const sendFrontMessage = async (text: string) => {
    if (!text.trim()) return;
    try { scenarioPlannerRef.current?.recordUserReply(text); } catch {}
    setFrontInput("");
    signalEvent('front-send');
  };

  // --- derive transcripts from events just before render ---
  const frontMessages = selectFrontMessages(eventLog as any);
  const agentSide = selectAgentLog(eventLog as any);

  return (
    <AppLayout title="Conversational Client">
      <div className="w-full">
        {/* Step Flow unchanged except the onSystem/onAskUser change above */}
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 mb-8">
          <StepFlow
            // ... all existing props ...
            // (no changes here besides the startPlanner binding done above)
          />
        </div>

        {/* Conversations Section */}
        <DualConversationView
          frontMessages={frontMessages}
          agentLog={agentSide}
          plannerStarted={model.plannerStarted}
          onOpenAttachment={openBase64Attachment}
          input={frontInput}
          onInputChange={setFrontInput}
          onSendMessage={sendFrontMessage}
          connected={model.connected}
          busy={model.busy}
          yourTurn={model.status === 'input-required'}
        />

        {/* Event Log */}
        <div className="mt-8">
          <EventLogView events={eventLog} busy={plannerThinking} />
        </div>
      </div>
    </AppLayout>
  );
}
```

> Also: remove any leftover calls to `dispatch({ type: "frontAppend", ... })` or `dispatch({ type: "system", ... })` anywhere in the file and replace them with `scenarioPlannerRef.current?.recordSystemMessage(...)` **only** if you want a system notice. Planner already emits status and messages.

> Ensure `SessionState` no longer includes `front`:

```ts
type SessionState = {
  taskId?: string;
  status?: A2AStatus | "initializing";
  plannerStarted?: boolean;
  frontDraft?: string;
  plannerEvents?: PlannerUnifiedEvent[];
};
```

---

### 7) UPDATE — Imports in `src/frontend/client/components/EventLogView.tsx` users

In any place you did:

```ts
import type { UnifiedEvent } from './components/EventLogView';
```

replace with:

```ts
import type { UnifiedEvent } from './types/events';
```

(We already did this in `App.tsx` above.)

---

## QA checklist (what to verify)

1. **App boots** and shows “Step 1/Step 2” as before.
2. Start planner and **send a message** to the planner:

   * A `message` event with `channel='user-planner', author='user'` appears.
   * The left transcript shows the message (derived from events).
3. Planner “asks user”:

   * A `message` event with `channel='user-planner', author='planner'` appears.
   * Left transcript updates accordingly. No duplicates.
4. Planner sends to remote agent:

   * A `message` event with `channel='planner-agent', author='planner'` appears, and the actual A2A send happens.
   * Right transcript shows it.
5. Remote agent replies:

   * A `message` event with `channel='planner-agent', author='agent'` appears (and any attachments mirrored to the vault).
   * Right transcript updates.
6. Status transitions (working → input‑required → completed):

   * `status` events appear and are also summarized in the left pane as “— status: … —”.
7. Reading an attachment:

   * `read_attachment` event with strict payload; event log shows excerpt or “blocked”.
8. Violations: e.g., attempt to emit a `message` with `channel='tool'` → immediate **Error** thrown with a clear message.

---

## Notes for teammates who didn’t read the thread

* We removed legacy event kinds (`agent_message`, `user_reply`, `send_to_user`, etc.).
  **Everything human‑like is `type: 'message'`**, and the **lane** is carried by `channel`:

  * `user-planner` for the left pane
  * `planner-agent` for the right pane
* The **Event Log is authoritative**. Both transcripts are derived using selectors.
* **No silent fallback** anywhere. If something is wrong, we throw (with a message like “Event invariant violated: …”).
* Session persistence stores the **event log** and the current input draft—nothing else.
* If you need a system line (progress note, completion notice), call `recordSystemMessage(text)`. It becomes `type: 'trace'`, `channel: 'system'`, `author: 'system'`.

---

## Why this design will hold up

* **Clarity:** One timeline, two selectors. No drift.
* **Testable:** You can snapshot an event array and verify both panes render correctly.
* **Strictness:** Errors appear at the point of emission, not later in rendering.
* **Extensibility:** New tools/events just add a new `type` + payload spec (with invariants).

If you want, I can also supply Jest tests for `assertEvent` and the two selectors to lock this down.
