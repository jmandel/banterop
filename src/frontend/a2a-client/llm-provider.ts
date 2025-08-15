import type { LLMProvider, LLMStepContext, ToolCall } from "./llm-types";
import { SYSTEM_PREAMBLE, TOOL_SCHEMA } from "./planner-instructions";

function apiBase(): string {
  const win = (globalThis as any)?.window;
  const fromWin = win?.__APP_CONFIG__?.API_BASE;
  return typeof fromWin === "string" && fromWin ? fromWin : "http://localhost:3000/api";
}

function extractJsonObject(text: string): any {
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const raw0 = fence ? fence[1] : text;
  const raw = (raw0 ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? raw.slice(start, end + 1) : raw.trim();
  try { return JSON.parse(candidate); } catch {}
  try { return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1")); } catch { throw new Error("LLM did not return valid JSON ToolCall"); }
}

export class ServerLLMProvider implements LLMProvider {
  name = "server-llm";
  constructor(private getModel?: () => string | undefined) {}
  async ready(): Promise<boolean> { return true; }

  async generateToolCall(ctx: LLMStepContext): Promise<ToolCall> {
    const lines: string[] = [];

    lines.push(SYSTEM_PREAMBLE.trim(), "", "TOOLS SPEC:", TOOL_SCHEMA.trim(), "");

    if (ctx.counterpartHint) {
      lines.push("COUNTERPART:");
      lines.push(ctx.counterpartHint.trim(), "");
    }

    // Voice and audience: speak directly to the counterpart as the user's agent
    lines.push("VOICE:");
    lines.push(
      "- Address the counterpart directly (no meta language).",
    );
    lines.push(
      "- Speak as the user's agent/representative, NOT as the user.",
    );
    if ((ctx.prior_mediator_messages || 0) === 0) {
      lines.push("- First contact: briefly identify yourself and purpose (one line max).",
                 "  e.g., 'I'm the care coordinator on behalf of …' ");
    } else {
      lines.push("- Ongoing thread: do not re-introduce yourself; continue concisely.");
    }
    lines.push(
      "- Refer to the user in third person by name/title when needed; do not claim to be them.",
      "",
    );

    lines.push("POLICY:");
    lines.push(`- has_task: ${ctx.policy.has_task}`);
    if (ctx.policy.planner_mode === 'approval') {
      lines.push(`- approval_mode: true (ask user before first send)`);
    }
    lines.push("");

    lines.push("SESSION BACKGROUND & GOALS:");
    lines.push(ctx.goals.trim() ? ctx.goals.trim() : "(none)", "");

    lines.push(`STATUS: ${ctx.status}`, "");

    lines.push("AVAILABLE_FILES:");
    if (ctx.available_files.length) {
      for (const f of ctx.available_files) {
        const kws = (f.keywords || []).join(", ");
        const summ = f.summary ? ` — ${f.summary}` : "";
        const priv = f.private ? " — [PRIVATE]" : "";
        lines.push(`- ${f.name} (${f.mimeType}, ${f.size} bytes)${priv}${summ}${kws ? ` [${kws}]` : ""}`);
      }
    } else {
      lines.push("- (none)");
    }
    lines.push("");

    lines.push("AGENT TASK HISTORY (full, newest last):");
    if (ctx.task_history_full.length) {
      for (const m of ctx.task_history_full) lines.push(`${m.role === "user" ? "MEDIATOR" : "AGENT"}: ${m.text}`);
    } else {
      lines.push("(empty)");
    }
    lines.push("");

    lines.push("USER↔PLANNER (recent, newest last):");
    if (ctx.user_mediator_recent.length) {
      for (const m of ctx.user_mediator_recent) lines.push(`${m.role.toUpperCase()}: ${m.text}`);
    } else {
      lines.push("(empty)");
    }
    lines.push("");

    if (ctx.tool_events_recent.length) {
      lines.push("RECENT TOOL EVENTS:");
      for (const ev of ctx.tool_events_recent.slice(-8)) {
        lines.push(`- TOOL: ${ev.tool} @ ${ev.at}`);
        lines.push(`  args: name="${ev.args.name}"${ev.args.purpose ? `, purpose="${ev.args.purpose}"` : ""}`);
        const r = ev.result;
        let desc = r.ok
          ? (r.description || (r.text_excerpt ? `text_excerpt(${r.text_excerpt.length} chars)${r.truncated ? " [truncated]" : ""}` : "ok"))
          : `blocked: ${r.reason || "unknown"}`;
        lines.push(`  result: ${desc}`);
      }
      lines.push("");
    }

    if (ctx.planner_events_recent.length) {
      lines.push("RECENT PLANNER EVENTS:");
      for (const ev of ctx.planner_events_recent.slice(-12)) {
        if (ev.type === 'asked_user') lines.push(`- asked_user @ ${ev.at}: ${ev.question}`);
        else if (ev.type === 'user_reply') lines.push(`- user_reply @ ${ev.at}: ${ev.text}`);
        else if (ev.type === 'sent_to_agent') {
          const att = ev.attachments?.map(a=>`${a.name} (${a.mimeType})`).join(', ');
          lines.push(`- sent_to_agent @ ${ev.at}: ${ev.text || '(no text)'}${att ? ` [attachments: ${att}]` : ''}`);
        } else if (ev.type === 'agent_message') {
          lines.push(`- agent_message @ ${ev.at}: ${ev.text || '(no text)'}`);
        } else if (ev.type === 'agent_document_added') {
          lines.push(`- agent_document_added @ ${ev.at}: ${ev.name} (${ev.mimeType})`);
        }
      }
      lines.push("");
    }

    lines.push("Return exactly ONE ToolCall JSON now (no extra text).");
    const prompt = lines.join("\n");
    console.log("[LLMProvider] Prompt length:", prompt.length);
    console.log("[LLMProvider] Status:", ctx.status);

    const body: any = {
      messages: [
        { role: "system", content: "You are a planner that emits ToolCall JSON only." },
        { role: "user", content: prompt },
      ],
      maxTokens: 512,
      temperature: 0.2,
    };
    const model = this.getModel?.();
    if (model) body.model = model;

    const res = await fetch(`${apiBase()}/llm/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`LLM error: ${res.status}`);
    const j = await res.json();
    const text = String(j?.content ?? "");
    console.log("[LLMProvider] LLM response:", text.slice(0, 200));
    if (!text) return { tool: "sleep", args: { ms: 250 } };
    return extractJsonObject(text) as ToolCall;
  }
}
