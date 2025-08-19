Absolutely—we can (and should) model **`send_to_agent`** exactly like your message API: **text + optional attachments** (each with `name`, `mimeType`, and either `bytes` or `uri`). Below is a **clean, event‑driven browser app** that:

* uses a **browser‑side LLM** (WindowAI if present; otherwise a safe mock),
* drives a **planner loop** that emits **single tool calls** (`send_to_agent`, `ask_user`, `get_task`, `sleep`, `done`) with **attachments**,
* supports **user file uploads** (and a small **demo script** and **sample files** mode),
* handles **SSE streams** for `message/stream` & `tasks/resubscribe`,
* exposes **`tasks/get` full snapshot**,
* and implements robust **message de‑duplication**, **partial updates**, **reconnects**, and **explicit cancel** semantics.

> **How attachments flow**
>
> * Files added in the UI are stored in a local **AttachmentVault** (`name`, `mimeType`, `bytes` as base64).
> * The LLM sees a **read‑only list** of `available_files` `{ name, mimeType, size }`.
> * When the LLM calls `send_to_agent`, it may include:
>
>   * `attachments: [{ name: "<exact name from available_files>" }]` (preferred; the vault resolves to bytes), or
>   * `attachments: [{ name, mimeType, bytes: "<base64>" }]` (simulated content), or
>   * `attachments: [{ name, mimeType, uri: "<https url or local>" }]`.
> * The orchestrator resolves the list into **A2A parts**:
>
>   * `{ kind: 'text', text }` for body text,
>   * `{ kind: 'file', file: { name, mimeType, bytes|uri } }` for each attachment.

---

## File tree

```
src/frontend/a2a-client/
├─ index.html
├─ main.tsx
├─ App.tsx
├─ styles.css
├─ a2a-client.ts
├─ a2a-types.ts
├─ a2a-utils.ts
├─ attachments-vault.ts
├─ llm-types.ts
├─ llm-provider.ts
├─ orchestrator.ts
├─ planner-instructions.ts
├─ scripts.ts
├─ package.json
├─ tsconfig.json
└─ vite.config.ts
```

---

### `index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover"
    />
    <title>A2A Browser Client</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

---

### `main.tsx`

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
```

---

### `styles.css`

```css
:root{
  --bg:#0c0d10;
  --panel:#121319;
  --border:#21222b;
  --text:#e6e7eb;
  --muted:#9aa0aa;
  --good:#1bb16e;
  --warn:#f2b84b;
  --bad:#ea5a59;
}

*{box-sizing:border-box}
html,body,#root{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;}

.app{max-width:980px;margin:0 auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px}
.row{display:flex;align-items:center;gap:8px}
.grow{flex:1}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:4px}
input,textarea,select{
  width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);
  background:#0f1015;color:var(--text);outline:none
}
textarea{resize:vertical}
button{
  padding:8px 12px;border-radius:8px;border:1px solid var(--border);
  background:#191b22;color:var(--text);cursor:pointer
}
button.primary{background:#2d60ff;border-color:#2d60ff}
button.ghost{background:transparent}
button:disabled{opacity:.6;cursor:not-allowed}

.tiny{font-size:12px}
.kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0c11;border:1px solid var(--border);border-radius:6px;padding:2px 6px}
.wrap{white-space:pre-wrap;word-break:break-word}
.scrollbox{max-height:160px;overflow:auto;padding:6px;border-radius:6px;background:#0b0c11}

.status{font-size:12px;color:var(--muted)}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid var(--border);margin-left:6px}
.pill.green{background:#0e2419;border-color:#0e2419;color:#87e2b7}
.pill.warn{background:#251f0c;border-color:#251f0c;color:#ffd892}
.pill.red{background:#2a1212;border-color:#2a1212;color:#ffb4b3}

.chat{display:flex;flex-direction:column;height:56vh}
.log{flex:1;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:12px;background:#0b0c11}
.bubble{max-width:75%;padding:10px;border-radius:10px;margin-bottom:8px;white-space:pre-wrap}
.bubble.who-you{margin-left:auto;background:#1a1f2b}
.bubble.who-them{margin-right:auto;background:#171c20}
.bubble.who-sys{margin:10px auto;color:var(--muted);text-align:center;background:transparent}
.bubble.partial{opacity:.85}

.toolbar{display:flex;justify-content:space-between;align-items:center;margin-top:8px}

.attach{display:flex;flex-direction:column;gap:8px}
.attach-list{display:flex;flex-wrap:wrap;gap:6px}
.badge{
  display:inline-flex;gap:6px;align-items:center;padding:4px 8px;border-radius:999px;
  background:#14151c;border:1px solid var(--border);font-size:12px
}
.badge .x{cursor:pointer;opacity:.7}
.badge .x:hover{opacity:1}
```

---

### `a2a-types.ts`

```ts
export type A2APart =
  | { kind: "text"; text: string }
  | {
      kind: "file";
      file: {
        name: string;
        mimeType: string;
        uri?: string;   // if remote or server-provided
        bytes?: string; // base64-encoded (no data: prefix)
      };
    };

export type A2AStatus =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

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
```

---

### `a2a-utils.ts`

```ts
// SSE reader for POST streams (EventSource only supports GET)
export async function* readSSE(resp: Response): AsyncGenerator<string> {
  if (!resp.body) return;
  const reader = (resp.body as any).getReader?.();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      const idx = buf.indexOf("\n\n");
      if (idx === -1) break;
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = chunk.split("\n");
      for (const line of lines) if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  if (buf.trim()) {
    const lines = buf.split("\n");
    for (const line of lines) if (line.startsWith("data:")) yield line.slice(5).trim();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function partsToText(parts?: Array<{ kind: string; text?: string }>): string {
  return (parts ?? [])
    .filter((p) => p?.kind === "text" && typeof (p as any).text === "string")
    .map((p) => (p as any).text as string)
    .join("\n")
    .trim();
}
```

---

### `a2a-client.ts`

```ts
import { A2AFrame, A2APart, A2ATask } from "./a2a-types";
import { readSSE } from "./a2a-utils";

export class A2AClient {
  constructor(private endpointUrl: string) {}
  private endpoint() {
    return this.endpointUrl;
  }

  async messageSendParts(parts: A2APart[], taskId?: string): Promise<A2ATask> {
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: { message: { ...(taskId ? { taskId } : {}), parts } },
    };
    const res = await fetch(this.endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });
    if (!res.ok) throw new Error(`message/send failed: ${res.status} ${await res.text()}`);
    const j = (await res.json()) as { result?: A2ATask; error?: { message: string } };
    if (!j.result) throw new Error(j.error?.message || "no result");
    return j.result;
  }

  async *messageStreamParts(parts: A2APart[], taskId?: string, signal?: AbortSignal): AsyncGenerator<A2AFrame> {
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/stream",
      params: { message: { ...(taskId ? { taskId } : {}), parts } },
    };
    const res = await fetch(this.endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      credentials: "include",
      signal,
    });
    if (!res.ok) throw new Error(`message/stream failed: ${res.status} ${await res.text()}`);
    for await (const data of readSSE(res)) {
      try {
        const obj = JSON.parse(data) as A2AFrame;
        if (obj && "result" in obj) yield obj;
      } catch {
        /* ignore parse errors */
      }
    }
  }

  async *tasksResubscribe(taskId: string, signal?: AbortSignal): AsyncGenerator<A2AFrame> {
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tasks/resubscribe",
      params: { id: taskId },
    };
    const res = await fetch(this.endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      credentials: "include",
      signal,
    });
    if (!res.ok) throw new Error(`resubscribe failed: ${res.status} ${await res.text()}`);
    for await (const data of readSSE(res)) {
      try {
        const obj = JSON.parse(data) as A2AFrame;
        if (obj && "result" in obj) yield obj;
      } catch { /* ignore */ }
    }
  }

  async tasksCancel(taskId: string): Promise<A2ATask> {
    const body = { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tasks/cancel", params: { id: taskId } };
    const res = await fetch(this.endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });
    if (!res.ok) throw new Error(`cancel failed: ${res.status} ${await res.text()}`);
    const j = (await res.json()) as { result?: A2ATask; error?: { message: string } };
    if (!j.result) throw new Error(j.error?.message || "no result");
    return j.result;
  }

  async tasksGet(taskId: string, include: "full" | "history" | "status" = "full"): Promise<A2ATask> {
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tasks/get",
      params: { id: taskId, include },
    };
    const res = await fetch(this.endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });
    if (!res.ok) throw new Error(`tasks/get failed: ${res.status} ${await res.text()}`);
    const j = (await res.json()) as { result?: A2ATask; error?: { message: string } };
    if (!j.result) throw new Error(j.error?.message || "no result");
    return j.result;
  }
}
```

---

### `attachments-vault.ts`

```ts
import { fileToBase64 } from "./a2a-utils";

export type LocalAttachment = {
  name: string;
  mimeType: string;
  bytes: string; // base64
  size: number;
};

export class AttachmentVault {
  private byName = new Map<string, LocalAttachment>();

  list(): LocalAttachment[] {
    return [...this.byName.values()];
  }

  getByName(name: string): LocalAttachment | undefined {
    return this.byName.get(name);
  }

  remove(name: string): void {
    this.byName.delete(name);
  }

  clear(): void {
    this.byName.clear();
  }

  async addFile(file: File): Promise<LocalAttachment> {
    const bytes = await fileToBase64(file);
    const att: LocalAttachment = {
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      bytes,
      size: file.size,
    };
    this.byName.set(att.name, att);
    return att;
  }

  addSynthetic(name: string, mimeType: string, contentUtf8: string): LocalAttachment {
    const bytes = btoa(unescape(encodeURIComponent(contentUtf8)));
    const att: LocalAttachment = { name, mimeType, bytes, size: contentUtf8.length };
    this.byName.set(name, att);
    return att;
  }
}
```

---

### `llm-types.ts`

```ts
import type { A2AStatus } from "./a2a-types";

export type SendToAgentAttachmentArg = {
  // Preferred: by name (must match available_files.name)
  name: string;
  // Optional overrides (when simulating content or explicit)
  mimeType?: string;
  bytes?: string; // base64 (no data: prefix)
  uri?: string;
  summary?: string;
  docId?: string;
};

export type ToolCall =
  | { tool: "send_to_agent"; args: { text?: string; attachments?: SendToAgentAttachmentArg[] } }
  | { tool: "ask_user"; args: { question: string } }
  | { tool: "get_task"; args?: {} }
  | { tool: "sleep"; args: { ms: number } }
  | { tool: "done"; args: { summary: string } };

export type LLMStepContext = {
  instructions: string;
  transcript: Array<{ role: "user" | "agent" | "system"; text: string }>;
  status: A2AStatus;
  available_files: Array<{ name: string; mimeType: string; size: number }>;
};

export interface LLMProvider {
  name: string;
  ready(): Promise<boolean>;
  // MUST return a single ToolCall in JSON (we'll parse robustly)
  generateToolCall(ctx: LLMStepContext): Promise<ToolCall>;
}
```

---

### `planner-instructions.ts`

```ts
export const TOOL_SCHEMA = `
Respond with EXACTLY ONE JSON object (no commentary) matching:

type ToolCall =
  | { "tool": "send_to_agent", "args": { "text"?: string, "attachments"?: Array<{ "name": string, "mimeType"?: string, "bytes"?: string, "uri"?: string, "summary"?: string, "docId"?: string }> } }
  | { "tool": "ask_user",      "args": { "question": string } }
  | { "tool": "get_task",      "args": {} }
  | { "tool": "sleep",         "args": { "ms": number } }
  | { "tool": "done",          "args": { "summary": string } };

Rules:
- You are event-driven. The host calls you again when NEW info arrives (agent reply, user input, status change).
- Do NOT wait proactively. Only use "sleep" for brief coalescing (<1000ms) if absolutely necessary.
- Prefer "send_to_agent" with concise text; attach files by name from available_files when needed.
- "ask_user" only when the agent needs information we don’t have.
- Finish with "done" when the goal is reached. Output ONLY the JSON (no backticks, no prose).
`;

export const SYSTEM_PREAMBLE = `
You coordinate a conversation between a user and an external agent via a single ToolCall per step.
You see a transcript, current status, and the list of locally available files you may attach by name.
Your job is to plan the next concrete action and output ONE ToolCall as strict JSON with no extra text.
`;
```

---

### `llm-provider.ts`

````ts
import { LLMProvider, LLMStepContext, ToolCall } from "./llm-types";
import { SYSTEM_PREAMBLE, TOOL_SCHEMA } from "./planner-instructions";

// Robust JSON extraction from model output
function extractJsonObject(text: string): any {
  // Prefer ```json code blocks
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  // Strip leading/trailing junk before first { and after last }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? raw.slice(start, end + 1) : raw.trim();
  try { return JSON.parse(candidate); } catch { /* try relaxed fixes */ }
  // Remove trailing commas (very common)
  try {
    const fixed = candidate.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(fixed);
  } catch (e) {
    throw new Error("LLM did not return valid JSON ToolCall");
  }
}

// Adapter for WindowAI if present; otherwise mock.
export class WindowAIProvider implements LLMProvider {
  name = "window.ai-or-mock";

  async ready(): Promise<boolean> {
    return typeof (globalThis as any).ai !== "undefined";
  }

  async generateToolCall(ctx: LLMStepContext): Promise<ToolCall> {
    const prompt = [
      SYSTEM_PREAMBLE.trim(),
      "",
      "TOOLS SPEC:",
      TOOL_SCHEMA.trim(),
      "",
      "TRANSCRIPT (newest last):",
      ...ctx.transcript.map((m) => `${m.role.toUpperCase()}: ${m.text}`),
      "",
      `STATUS: ${ctx.status}`,
      "AVAILABLE_FILES:",
      ...(ctx.available_files.length
        ? ctx.available_files.map((f) => `- ${f.name} (${f.mimeType}, ${f.size} bytes)`)
        : ["- (none)"]),
      "",
      "INSTRUCTIONS:",
      ctx.instructions.trim(),
      "",
      "Return exactly one ToolCall JSON now:",
    ].join("\n");

    const ai: any = (globalThis as any).ai;

    let text: string | undefined;

    // Try v1
    if (ai?.generateText) {
      const res = await ai.generateText({ prompt });
      text = res?.text;
    }

    // Try languageModel session
    if (!text && ai?.languageModel?.create) {
      const session = await ai.languageModel.create();
      try {
        // non-streaming
        const res = await session.prompt(prompt);
        text = typeof res === "string" ? res : res?.text;
      } catch {
        // streaming fallback
        const stream = await session.promptStreaming(prompt);
        let out = "";
        for await (const chunk of stream) out += (chunk?.text ?? String(chunk ?? ""));
        text = out;
      } finally {
        try { await session.destroy?.(); } catch {}
      }
    }

    // Fallback mock if no provider or failed
    if (!text) {
      text = JSON.stringify({ tool: "get_task", args: {} });
    }

    const obj = extractJsonObject(String(text));
    return obj as ToolCall;
  }
}

// Minimal Mock provider (deterministic)
export class MockProvider implements LLMProvider {
  name = "mock";
  async ready(): Promise<boolean> { return true; }
  async generateToolCall(ctx: LLMStepContext): Promise<ToolCall> {
    // If agent spoke last, ask user to confirm; else send a short ack
    const last = ctx.transcript[ctx.transcript.length - 1];
    if (last?.role === "agent") {
      return { tool: "send_to_agent", args: { text: "Acknowledged. Proceeding." } };
    }
    return { tool: "get_task", args: {} };
  }
}

export async function pickProvider(): Promise<LLMProvider> {
  const w = new WindowAIProvider();
  if (await w.ready()) return w;
  return new MockProvider();
}
````

---

### `orchestrator.ts`

```ts
import { A2AClient } from "./a2a-client";
import { A2APart, A2AStatus } from "./a2a-types";
import { sleep } from "./a2a-utils";
import { AttachmentVault } from "./attachments-vault";
import { LLMProvider, LLMStepContext, ToolCall } from "./llm-types";

export type PlannerHooks = {
  onSystem: (text: string) => void;
  onAskUser: (question: string) => void;
  onSendToAgentEcho?: (text: string) => void;
  applyFrame?: (frame: any) => void; // optional: push task snapshot into UI
};

export type PlannerDeps = PlannerHooks & {
  provider: LLMProvider;
  a2a: A2AClient;
  vault: AttachmentVault;
  getTaskId: () => string | undefined;
  getTranscript: () => Array<{ role: "user" | "agent" | "system"; text: string }>;
  getTaskSnapshot: () => any;
  getStatus: () => A2AStatus;
  waitNextEvent: () => Promise<void>;
  getInstructions: () => string;
};

export class Orchestrator {
  private running = false;
  private ac: AbortController | null = null;
  constructor(private opts: PlannerDeps) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.ac = new AbortController();
    void this.loop();
  }

  stop() {
    this.running = false;
    this.ac?.abort();
  }

  private buildContext(): LLMStepContext {
    return {
      instructions: this.opts.getInstructions(),
      transcript: this.opts.getTranscript(),
      status: this.opts.getStatus(),
      available_files: this.opts.vault.list().map(({ name, mimeType, size }) => ({ name, mimeType, size })),
    };
  }

  private resolveParts(args: { text?: string; attachments?: Array<{ name: string; mimeType?: string; bytes?: string; uri?: string; summary?: string; docId?: string }> }): A2APart[] {
    const parts: A2APart[] = [];
    if (args.text && args.text.trim()) {
      parts.push({ kind: "text", text: args.text.trim() });
    }
    for (const a of args.attachments ?? []) {
      if (!a?.name) continue;
      // prefer vault by name
      const local = this.opts.vault.getByName(a.name);
      if (local) {
        parts.push({ kind: "file", file: { name: local.name, mimeType: local.mimeType, bytes: local.bytes } });
      } else {
        // pass-through explicit content or uri
        if (a.bytes) {
          parts.push({ kind: "file", file: { name: a.name, mimeType: a.mimeType || "application/octet-stream", bytes: a.bytes } });
        } else if (a.uri) {
          parts.push({ kind: "file", file: { name: a.name, mimeType: a.mimeType || "application/octet-stream", uri: a.uri } });
        }
      }
    }
    return parts;
  }

  private async runTool(tool: ToolCall): Promise<void> {
    switch (tool.tool) {
      case "send_to_agent": {
        const parts = this.resolveParts(tool.args || {});
        const text = (tool.args?.text ?? "").trim();
        if (text && this.opts.onSendToAgentEcho) this.opts.onSendToAgentEcho(`(auto) ${text}`);
        const taskId = this.opts.getTaskId();
        if (taskId) await this.opts.a2a.messageSendParts(parts, taskId);
        else await this.opts.a2a.messageSendParts(parts);
        return; // wait for agent frames
      }

      case "ask_user": {
        const q = tool.args?.question?.trim() || "Please advise.";
        this.opts.onAskUser(q);
        return; // wait for user input
      }

      case "get_task": {
        const id = this.opts.getTaskId();
        if (id) {
          try {
            const t = await this.opts.a2a.tasksGet(id, "full");
            this.opts.applyFrame?.({ result: t });
            this.opts.onSystem("Refreshed task snapshot.");
          } catch (e: any) {
            this.opts.onSystem(`get_task failed: ${String(e?.message ?? e)}`);
          }
        }
        return;
      }

      case "sleep": {
        const ms = Math.max(0, Number(tool.args?.ms ?? 0));
        await sleep(Math.min(ms, 1000));
        return;
      }

      case "done": {
        this.opts.onSystem(`— automation done — ${tool.args?.summary ?? ""}`);
        this.stop();
        return;
      }
    }
  }

  private async loop(): Promise<void> {
    while (this.running && !this.ac?.signal.aborted) {
      // Build step context & ask the LLM
      let tool: ToolCall | null = null;
      try {
        tool = await this.opts.provider.generateToolCall(this.buildContext());
      } catch (e: any) {
        this.opts.onSystem(`LLM error: ${String(e?.message ?? e)}`);
        break;
      }

      // Execute tool, then suspend until something happens
      try {
        if (!tool || typeof tool !== "object" || !("tool" in tool)) throw new Error("invalid tool call");
        await this.runTool(tool);
      } catch (e: any) {
        this.opts.onSystem(`Tool error: ${String(e?.message ?? e)}`);
      }

      await this.opts.waitNextEvent(); // agent frames / status changes / user input wake us up
    }
  }
}
```

---

### `scripts.ts`

```ts
export type ScriptTurn = { role: "user" | "agent"; text: string; delayMs?: number };

export const bookingDemo: ScriptTurn[] = [
  { role: "user", text: "Goal: Book a table for two at 7pm." },
  { role: "agent", text: "Sure—what date would you like?" },
  { role: "user", text: "Tomorrow." },
  { role: "agent", text: "Got it. Any cuisine preferences?" },
  { role: "user", text: "Italian." },
];
```

---

### `App.tsx`

```tsx
import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { A2AClient } from "./a2a-client";
import { A2AFrame, A2AMessage, A2AStatus, A2AStatusUpdate, A2ATask } from "./a2a-types";
import { partsToText, sleep } from "./a2a-utils";
import { AttachmentVault } from "./attachments-vault";
import { bookingDemo, ScriptTurn } from "./scripts";
import { Orchestrator } from "./orchestrator";
import { LLMProvider } from "./llm-types";
import { pickProvider } from "./llm-provider";

type Msg = { id: string; role: "you" | "counterparty" | "system"; text: string; partial?: boolean };

type Model = {
  connected: boolean;
  endpoint: string;
  taskId?: string;
  status: A2AStatus;
  messages: Msg[];
  seenServerIds: Record<string, true>;
  busy: boolean;
  error?: string;
  autoRespond: boolean;
  demoScriptOn: boolean;
  instructions: string;
};

type Act =
  | { type: "connect"; endpoint: string }
  | { type: "setTask"; taskId: string }
  | { type: "status"; status: A2AStatus }
  | { type: "append"; msg: Msg }
  | { type: "appendServer"; msg: Msg }
  | { type: "removeId"; id: string }
  | { type: "system"; text: string }
  | { type: "busy"; busy: boolean }
  | { type: "error"; error?: string }
  | { type: "toggleAuto"; on: boolean }
  | { type: "toggleScript"; on: boolean }
  | { type: "setInstructions"; text: string }
  | { type: "reset" };

const initModel = (endpoint: string): Model => ({
  connected: false,
  endpoint,
  status: "submitted",
  messages: [],
  seenServerIds: {},
  busy: false,
  autoRespond: false,
  demoScriptOn: false,
  instructions:
    "Primary goal: help the user accomplish their task with minimal back-and-forth. " +
    "Prefer sending concise messages to the agent. Only ask the user when necessary.",
});

function reducer(m: Model, a: Act): Model {
  switch (a.type) {
    case "connect":
      return { ...m, connected: true, endpoint: a.endpoint, error: undefined };
    case "setTask":
      return { ...m, taskId: a.taskId };
    case "status":
      return { ...m, status: a.status };
    case "append":
      return { ...m, messages: [...m.messages, a.msg] };
    case "appendServer": {
      if (m.seenServerIds[a.msg.id]) return m;
      let msgs = m.messages;
      if (a.msg.role === "you") {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const mm = msgs[i];
          if (!mm) continue;
          if (mm.role === "you" && mm.text === a.msg.text && !(m.seenServerIds[mm.id])) {
            msgs = [...msgs.slice(0, i), ...msgs.slice(i + 1)];
            break;
          }
        }
      }
      return { ...m, messages: [...msgs, a.msg], seenServerIds: { ...m.seenServerIds, [a.msg.id]: true } };
    }
    case "removeId":
      return { ...m, messages: m.messages.filter((x) => x.id !== a.id) };
    case "system":
      return { ...m, messages: [...m.messages, { id: crypto.randomUUID(), role: "system", text: a.text }] };
    case "busy":
      return { ...m, busy: a.busy };
    case "error":
      return { ...m, error: a.error };
    case "toggleAuto":
      return { ...m, autoRespond: a.on };
    case "toggleScript":
      return { ...m, demoScriptOn: a.on };
    case "setInstructions":
      return { ...m, instructions: a.text };
    case "reset":
      return { ...initModel(m.endpoint) };
    default:
      return m;
  }
}

export default function App() {
  const initialEndpoint = localStorage.getItem("a2a.endpoint") || "";
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [resumeTask, setResumeTask] = useState("");
  const [input, setInput] = useState("");
  const [card, setCard] = useState<any | null>(null);
  const [cardLoading, setCardLoading] = useState(false);

  const vaultRef = useRef(new AttachmentVault());
  const resubscribeAbort = useRef<AbortController | null>(null);
  const streamingAbort = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const eventQ = useRef<{ resolve?: () => void }>({});
  const clientRef = useRef<A2AClient | null>(null);
  const providerRef = useRef<LLMProvider | null>(null);
  const orchestratorRef = useRef<Orchestrator | null>(null);
  const taskSnapshotRef = useRef<any>(null);
  const [model, dispatch] = useReducer(reducer, initModel(initialEndpoint));

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [model.messages.length]);

  useEffect(() => {
    localStorage.setItem("a2a.endpoint", endpoint);
  }, [endpoint]);

  // wake LLM loop
  const notifyPlanner = () => eventQ.current.resolve?.();
  const waitPlannerEvent = () => new Promise<void>((res) => (eventQ.current.resolve = res));

  // Build transcript for LLM (trim to last ~20 messages)
  const transcript = useMemo(
    () =>
      model.messages.slice(-20).map((m) => ({
        role: m.role === "you" ? "user" : m.role === "counterparty" ? "agent" : "system",
        text: m.text,
      })) as Array<{ role: "user" | "agent" | "system"; text: string }>,
    [model.messages]
  );

  const taskSnapshot = () => taskSnapshotRef.current;
  const getStatus = () => model.status;

  // client & provider
  useEffect(() => {
    if (!model.connected) return;
    clientRef.current = new A2AClient(model.endpoint);
    (async () => {
      providerRef.current = await pickProvider();
      dispatch({ type: "system", text: `LLM provider: ${providerRef.current.name}` });
    })();
  }, [model.connected, model.endpoint]);

  // fetch agent card on connect
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!model.connected || !model.endpoint) return;
      setCard(null);
      setCardLoading(true);
      try {
        const base = model.endpoint.replace(/\/+$/, "");
        const url = `${base}/.well-known/agent-card.json`;
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(`Agent card fetch failed: ${res.status}`);
        const j = await res.json();
        if (!cancelled) setCard(j);
      } catch (e: any) {
        if (!cancelled) setCard({ error: String(e?.message ?? e) });
      } finally {
        if (!cancelled) setCardLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [model.connected, model.endpoint]);

  // Apply frames into state (and wake planner)
  const applyFrame = (frame: A2AFrame) => {
    const r: any = (frame as any).result;
    if (!r) return;

    if (r.kind === "task") {
      const t = r as A2ATask;
      taskSnapshotRef.current = t;
      if (!model.taskId) dispatch({ type: "setTask", taskId: t.id });
      if (Array.isArray(t.history)) {
        for (const h of t.history) {
          const text = partsToText(h.parts);
          if (!text) continue;
          const role = h.role === "user" ? "you" : "counterparty";
          dispatch({ type: "appendServer", msg: { id: h.messageId, role, text } });
        }
      }
      dispatch({ type: "status", status: (t.status?.state ?? "submitted") as A2AStatus });
      const sm = t.status?.message;
      if (sm && Array.isArray(sm.parts)) {
        const text = partsToText(sm.parts);
        if (text) {
          if (t.status.state === "working") {
            dispatch({ type: "removeId", id: sm.messageId + ":partial" });
            dispatch({ type: "append", msg: { id: sm.messageId + ":partial", role: "counterparty", text, partial: true } });
          } else {
            dispatch({ type: "removeId", id: sm.messageId + ":partial" });
            dispatch({ type: "appendServer", msg: { id: sm.messageId, role: sm.role === "user" ? "you" : "counterparty", text } });
          }
        }
      }
      notifyPlanner();
      return;
    }

    if (r.kind === "message" && r.messageId) {
      const m = r as A2AMessage;
      const text = partsToText(m.parts);
      if (text) {
        const role = m.role === "user" ? "you" : "counterparty";
        dispatch({ type: "appendServer", msg: { id: m.messageId, role, text } });
      }
      notifyPlanner();
      return;
    }

    if (r.kind === "status-update") {
      const su = r as A2AStatusUpdate;
      const prev = model.status;
      dispatch({ type: "status", status: su.status.state as A2AStatus });
      const m = su.status.message;
      if (m) {
        const text = partsToText(m.parts);
        if (text) {
          if (su.status.state === "working") {
            dispatch({ type: "removeId", id: m.messageId + ":partial" });
            dispatch({ type: "append", msg: { id: m.messageId + ":partial", role: "counterparty", text, partial: true } });
          } else {
            dispatch({ type: "removeId", id: m.messageId + ":partial" });
            dispatch({ type: "appendServer", msg: { id: m.messageId, role: m.role === "user" ? "you" : "counterparty", text } });
          }
        }
      }
      if (su.status.state !== prev) {
        if (su.status.state === "input-required") dispatch({ type: "system", text: "— your turn now —" });
        if (su.status.state === "completed") dispatch({ type: "system", text: "— conversation completed —" });
        if (su.status.state === "failed") dispatch({ type: "system", text: "— conversation failed —" });
        if (su.status.state === "canceled") dispatch({ type: "system", text: "— conversation canceled —" });
      }
      notifyPlanner();
      return;
    }
  };

  // Resubscribe with auto-retry
  const openResubscribe = async (taskId: string) => {
    const client = clientRef.current!;
    resubscribeAbort.current?.abort();
    const ac = new AbortController();
    resubscribeAbort.current = ac;

    while (!ac.signal.aborted) {
      try {
        for await (const frame of client.tasksResubscribe(taskId, ac.signal)) {
          applyFrame(frame);
        }
      } catch (e: any) {
        if (ac.signal.aborted) return;
        dispatch({ type: "error", error: `resubscribe error: ${String(e?.message ?? e)}` });
        await sleep(500); // quick backoff
      }
    }
  };

  // Connect
  const handleConnect = async () => {
    dispatch({ type: "reset" });
    dispatch({ type: "connect", endpoint });
    clientRef.current = new A2AClient(endpoint);

    if (resumeTask.trim()) {
      const id = resumeTask.trim();
      dispatch({ type: "setTask", taskId: id });
      try {
        const snapshot = await clientRef.current.tasksGet(id, "full");
        applyFrame({ result: snapshot });
      } catch (e: any) {
        dispatch({ type: "error", error: String(e?.message ?? e) });
      }
      await sleep(0);
      openResubscribe(id);
    }
  };

  // Manual send (text only). For attachments & automation, the planner uses `send_to_agent`.
  const sendMessage = async (text: string) => {
    const client = clientRef.current!;
    dispatch({ type: "append", msg: { id: crypto.randomUUID(), role: "you", text } });

    if (!model.taskId) {
      const ac = new AbortController();
      streamingAbort.current?.abort();
      streamingAbort.current = ac;
      dispatch({ type: "busy", busy: true });
      try {
        for await (const frame of client.messageStreamParts([{ kind: "text", text }], undefined, ac.signal)) {
          const r: any = frame.result;
          if (r?.kind === "task" && !model.taskId) {
            dispatch({ type: "setTask", taskId: r.id });
            openResubscribe(r.id);
          }
          applyFrame(frame);
        }
      } catch (e: any) {
        if (!ac.signal.aborted) dispatch({ type: "error", error: String(e?.message ?? e) });
      } finally {
        dispatch({ type: "busy", busy: false });
      }
    } else {
      try {
        await client.messageSendParts([{ kind: "text", text }], model.taskId);
        openResubscribe(model.taskId);
      } catch (e: any) {
        dispatch({ type: "error", error: String(e?.message ?? e) });
      }
    }
  };

  const cancelTask = async () => {
    if (!clientRef.current || !model.taskId) return;
    try {
      await clientRef.current.tasksCancel(model.taskId);
    } catch (e: any) {
      dispatch({ type: "error", error: String(e?.message ?? e) });
    }
  };

  // Demo script: injects messages to stimulate the planner
  const playScript = async (script: ScriptTurn[]) => {
    for (const s of script) {
      if (!model.demoScriptOn) break;
      await sleep(s.delayMs ?? 400);
      const role = s.role === "user" ? "you" : "counterparty";
      dispatch({ type: "append", msg: { id: crypto.randomUUID(), role, text: s.text } });
      notifyPlanner();
    }
  };

  // Start automation (planner loop)
  const startAutomation = async () => {
    const provider = providerRef.current;
    const client = clientRef.current;
    if (!provider || !client) {
      dispatch({ type: "system", text: "Provider or client not ready yet." });
      return;
    }
    orchestratorRef.current?.stop();
    orchestratorRef.current = new Orchestrator({
      provider,
      a2a: client,
      vault: vaultRef.current,
      getTaskId: () => model.taskId,
      getTranscript: () => transcript,
      getTaskSnapshot: () => taskSnapshot(),
      getStatus: () => getStatus(),
      waitNextEvent: waitPlannerEvent,
      getInstructions: () => model.instructions,
      onSystem: (t) => dispatch({ type: "system", text: t }),
      onAskUser: (q) => dispatch({ type: "append", msg: { id: crypto.randomUUID(), role: "system", text: `LLM asks user: ${q}` } }),
      onSendToAgentEcho: (t) => dispatch({ type: "append", msg: { id: crypto.randomUUID(), role: "you", text: t } }),
      applyFrame, // optional
    });
    orchestratorRef.current.start();

    if (model.demoScriptOn) {
      void playScript(bookingDemo);
    }
  };

  // UI
  const statusPill = useMemo(() => {
    const s = model.status;
    const map: Record<A2AStatus, { label: string; cls: string }> = {
      submitted: { label: "submitted", cls: "" },
      working: { label: "working…", cls: "" },
      "input-required": { label: "your turn", cls: "warn" },
      completed: { label: "completed", cls: "green" },
      failed: { label: "failed", cls: "red" },
      canceled: { label: "canceled", cls: "" },
    };
    const m = map[s];
    return <span className={`pill ${m.cls}`}>{m.label}</span>;
  }, [model.status]);

  return (
    <div className="app">
      {/* Connection */}
      <div className="panel">
        <div className="row" style={{ gap: 12 }}>
          <div className="grow">
            <label>A2A Endpoint URL</label>
            <input
              type="text"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="http://localhost:3000/api/bridge/<config64>/a2a"
            />
          </div>
          <div style={{ minWidth: 200 }}>
            <label>Resume Task ID (optional)</label>
            <input type="text" value={resumeTask} onChange={(e) => setResumeTask(e.target.value)} placeholder="e.g. 42" />
          </div>
          <div>
            <label>&nbsp;</label>
            <button className="primary" onClick={handleConnect} disabled={!endpoint}>
              {model.connected ? "Reconnect" : "Connect"}
            </button>
          </div>
        </div>

        <div className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
          <div className="status">
            Status: {statusPill}{" "}
            {model.taskId ? (
              <span className="tiny">
                {" "}
                • task: <span className="kbd">{model.taskId}</span>
              </span>
            ) : null}
          </div>
          <div className="row">
            <label className="tiny" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={model.demoScriptOn}
                onChange={(e) => dispatch({ type: "toggleScript", on: e.target.checked })}
                style={{ verticalAlign: "middle", marginRight: 6 }}
              />
              Demo script
            </label>
            <button className="ghost" onClick={startAutomation}>Start automation</button>
            <button className="ghost" onClick={cancelTask} disabled={!model.taskId}>Cancel</button>
          </div>
        </div>

        <div className="tiny wrap" style={{ marginTop: 6, color: "var(--muted)" }}>
          Endpoint:
          <div className="kbd scrollbox" style={{ marginTop: 4 }}>
            {model.endpoint || "(not connected)"}
          </div>
        </div>

        {model.error ? (
          <div className="tiny" style={{ color: "var(--bad)", marginTop: 6 }}>
            Error: {model.error}
          </div>
        ) : null}
      </div>

      {/* Agent card */}
      {model.connected && (
        <div className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div style={{ fontWeight: 600 }}>Agent Card</div>
            {cardLoading ? <div className="tiny" style={{ color: "var(--muted)" }}>loading…</div> : null}
          </div>
          {card?.error ? (
            <div className="tiny" style={{ color: "var(--bad)" }}>Agent card error: {card.error}</div>
          ) : card ? (
            <div className="tiny" style={{ color: "var(--muted)" }}>
              {card.name || "—"} {card.description ? <>— {card.description}</> : null}
            </div>
          ) : null}
        </div>
      )}

      {/* Attachments */}
      <div className="panel attach">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div style={{ fontWeight: 600 }}>Pending files (available to LLM)</div>
          <div className="row">
            <input
              id="file-input"
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={async (e) => {
                const files = e.target.files ? Array.from(e.target.files) : [];
                for (const f of files) {
                  if (f.size > 4 * 1024 * 1024) { // 4MB soft cap
                    dispatch({ type: "system", text: `Skipping ${f.name} (too large)` });
                    continue;
                  }
                  await vaultRef.current.addFile(f);
                }
                (e.target as any).value = "";
              }}
            />
            <label htmlFor="file-input"><button className="ghost">Add files…</button></label>
            <button className="ghost" onClick={() => vaultRef.current.addSynthetic("notes.txt", "text/plain", "Sample notes.\nLine 2.")}>
              Add sample
            </button>
            <button className="ghost" onClick={() => vaultRef.current.clear()}>Clear</button>
          </div>
        </div>
        <div className="attach-list">
          {vaultRef.current.list().map((f) => (
            <span key={f.name} className="badge">
              {f.name} <span style={{ color: "var(--muted)" }}>({f.mimeType})</span>
              <span className="x" onClick={() => { vaultRef.current.remove(f.name); }}>✕</span>
            </span>
          ))}
          {vaultRef.current.list().length === 0 ? (
            <div className="tiny" style={{ color: "var(--muted)" }}>(no files)</div>
          ) : null}
        </div>
      </div>

      {/* Planner instructions */}
      <div className="panel">
        <label>Automation instructions (shown to LLM)</label>
        <textarea
          rows={4}
          value={model.instructions}
          onChange={(e) => dispatch({ type: "setInstructions", text: e.target.value })}
        />
      </div>

      {/* Chat */}
      <div className="panel chat">
        <div className="log" ref={logRef}>
          {model.messages.map((m) => (
            <div key={m.id} className={`bubble ${m.role === "you" ? "who-you" : m.role === "counterparty" ? "who-them" : "who-sys"} ${m.partial ? "partial" : ""}`}>
              {m.text}
            </div>
          ))}
          {!model.messages.length ? (
            <div className="tiny" style={{ textAlign: "center", color: "var(--muted)" }}>
              No messages yet. Connect, then type a message, or press “Start automation”.
            </div>
          ) : null}
        </div>

        {/* Composer (manual user message) */}
        <div className="composer">
          <textarea
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message…"
            onKeyDown={async (e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const text = input.trim();
                if (text) {
                  setInput("");
                  await sendMessage(text);
                  notifyPlanner();
                }
              }
            }}
          />
          <div className="toolbar">
            <div className="tiny">
              Shortcuts: <span className="kbd">Enter</span> to send, <span className="kbd">Shift+Enter</span> for newline
            </div>
            <div className="row">
              <button onClick={() => setInput("")} className="ghost">Clear</button>
              <button
                className="primary"
                disabled={!model.connected || !input.trim() || model.busy}
                onClick={async () => {
                  const text = input.trim();
                  setInput("");
                  await sendMessage(text);
                  notifyPlanner();
                }}
              >
                {model.busy ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ textAlign: "center", color: "var(--muted)" }}>
        A2A Browser Client • Event‑driven planner • Attachments supported
      </div>
    </div>
  );
}
```

---


## Why this design is robust & easy to reason about

* **Event‑driven planner**: the LLM never busy‑waits; we wake it on **new frames** (agent replies, status updates) or **user input**. This eliminates racey `wait_for` calls.
* **Single tool per step**: the LLM outputs **one ToolCall JSON**. The host performs it, then suspends until new info arrives. Easy to trace.
* **Attachment contract mirrors server**: `send_to_agent` uses the same `parts` model, just friendlier for the LLM (name‑based resolution via the vault).
* **LLM sees what it can use**: `available_files` lists exactly what’s attachable; the planner resolves by `name`, so no user‑visible leakage of bytes.
* **Resilient streaming**: POST‑SSE reader handles chunking, framing; `tasks/resubscribe` is auto‑reconnecting with a small backoff.
* **User control**: manual composer coexists with automation; demo script can stimulate the loop without a real agent.
* **Cancel semantics**: the UI treats `canceled` as a **status update** (system line). If your bridge also emits a message, it won’t dominate the UI.

---

### Hooking this up to your server

* Base URL for the client endpoint is your **A2A base**:
  `http://localhost:3000/api/bridge/:config64/a2a`
  (as you requested, **no `/v1`**, ends in `/a2a`).
* The client fetches `/.well-known/agent-card.json` relative to that base, so it works per‑scenario (`/:b64/a2a/.well-known/agent-card.json`).
* `tasks/get` displays the **full snapshot** (history + status + optional message) and integrates directly into the transcript.

If you want me to tailor the planner prompt to a specific scenario (e.g., your knee MRI or vision screening flows) or add richer **tool calls** (like structured forms), I can extend the tool schema and instructions.
