import type { LLMProvider, LLMStepContext, ToolCall } from "./llm-types";
import { SYSTEM_PREAMBLE } from "./planner-instructions";

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

    // Dynamic tool spec: restrict available tools to what is permitted now
    const attachmentsAvailable = (ctx.available_files?.length || 0) > 0;
    const allowSendToAgent = (ctx.status === 'input-required') || (!ctx.policy?.has_task);
    const TOOL_SPEC = (() => {
      const sendToAgent = allowSendToAgent
        ? `  | { "tool": "send_to_agent",      "args": { "text"?: string${attachmentsAvailable ? ", \"attachments\"?: Array<{ \"name\": string, \"mimeType\"?: string, \"bytes\"?: string, \"uri\"?: string, \"summary\"?: string, \"docId\"?: string }>" : ""} } }\n`
        : ``;
      const read = attachmentsAvailable
        ? `  | { "tool": "read_attachment", "args": { "name": string, "purpose"?: string } }\n`
        : ``;
      return (
        `Respond with EXACTLY ONE JSON object (no commentary) matching:\n\n` +
        `type ToolCall =\n` +
        `${sendToAgent}` +
        `${read}` +
        `  | { "tool": "send_to_local_user", "args": { "text": string } }\n` +
        `  | { "tool": "sleep",              "args": { } }\n` +
        `  | { "tool": "done",               "args": { "summary": string } };\n\n` +
        `Rules:\n` +
        `- You are event-driven: the host wakes you when NEW info arrives (agent reply, user input, status change, file changes, or tool results).\n` +
        (attachmentsAvailable ? `- Use \"read_attachment\" to examine a file when appropriate.\n` : ``) +
        (allowSendToAgent ? `- Prefer \"send_to_agent\" with concise text. When attaching, choose ONLY from AVAILABLE_FILES by NAME; do not invent files.\n` : ``) +
        `- Use \"send_to_local_user\" to report progress or ask questions when you need information/approval or when the agent requests info from the user.\n` +
        `- Use \"sleep\" to wait for the next event (you'll be woken when something happens).\n` +
        `- Finish with \"done\" when the objective is achieved.\n` +
        `- Output ONLY the JSON (no backticks, no extra prose).\n`
      );
    })();

    lines.push("<SYSTEM>");
    lines.push(SYSTEM_PREAMBLE.trim());
    lines.push("</SYSTEM>");
    lines.push("");
    lines.push("<TOOLS_SPEC>");
    lines.push(TOOL_SPEC.trim());
    lines.push("</TOOLS_SPEC>");
    lines.push("");

    if (ctx.counterpartHint) {
      lines.push("<COUNTERPART>");
      // ctx.counterpartHint is already a concise sentence tailored by the host
      lines.push(ctx.counterpartHint.trim());
      lines.push("</COUNTERPART>");
      lines.push("");
    }

    // Voice and audience: speak directly to the counterpart as the user's agent
    lines.push("<VOICE>");
    lines.push(
      "- Address the counterpart directly (no meta language).",
    );
    lines.push(
      "- Speak as the user's agent/representative, NOT as the user;",
    );
    lines.push(
      "  or as directed in your session background/goals below.",
    );
    if ((ctx.prior_mediator_messages || 0) === 0) {
      lines.push("- First contact: briefly identify yourself and purpose (one line max).",
                 "  e.g., 'I'm the care coordinator on behalf of …' ");
    } else {
      lines.push("- Ongoing thread: do not re-introduce yourself; continue concisely.");
    }
    lines.push(
      "- Refer to the user in third person by name/title when needed; do not claim to be them.",
    );
    lines.push("</VOICE>");
    lines.push("");

    // Remove policy and allowed-actions prose; the tool schema above already constrains allowed actions.

    lines.push("<SESSION_BACKGROUND_AND_GOALS>");
    lines.push(ctx.goals.trim() ? ctx.goals.trim() : "(none)", "");
    lines.push("</SESSION_BACKGROUND_AND_GOALS>");

    // Planner instructions from UI (explicit guidance)
    lines.push("<PLANNER_INSTRUCTIONS>");
    lines.push(ctx.instructions.trim() ? ctx.instructions.trim() : "(none)");
    lines.push("</PLANNER_INSTRUCTIONS>");
    
    lines.push("<STATUS>");
    lines.push(`${ctx.status}`);
    lines.push("</STATUS>");
    lines.push("");

    lines.push("<AVAILABLE_FILES>");
    if (ctx.available_files.length) {
      for (const f of ctx.available_files) {
        const kws = (f.keywords || []).join(", ");
        const summ = f.summary ? ` — ${f.summary}` : "";
        const priv = f.private ? " — [PRIVATE]" : "";
        const name = (f.name || '').toString();
        lines.push(`- filename: "${name}" (${f.mimeType}, ${f.size} bytes)${priv}${summ}${kws ? ` [keywords: ${kws}]` : ""}`);
      }
    } else {
      lines.push("- (none)");
    }
    lines.push("</AVAILABLE_FILES>");
    lines.push("");

    // Omit detailed history and recent mediator logs by request (redundant in current UI)

    if (ctx.tool_events_recent.length) {
      lines.push("<RECENT_TOOL_EVENTS>");
      for (const ev of ctx.tool_events_recent.slice(-8)) {
        lines.push(`- TOOL: ${ev.tool} @ ${ev.at}`);
        lines.push(`  args: { "name": "${ev.args.name}"${ev.args.purpose ? `, "purpose": "${ev.args.purpose}"` : ""} }`);
        const r = ev.result;
        let desc = r.ok
          ? (r.description || (r.text_excerpt ? `text_excerpt(${r.text_excerpt.length} chars)${r.truncated ? " [truncated]" : ""}` : "ok"))
          : `blocked: ${r.reason || "unknown"}`;
        lines.push(`  result: ${desc}`);
      }
      lines.push("</RECENT_TOOL_EVENTS>");
      lines.push("");
    }

    if (ctx.planner_events_recent.length) {
      lines.push("<EVENT_LOG>");
      
      // Smart slicing: if too many events, keep first 10% and last 90%
      const MAX_EVENTS_IN_PROMPT = 200;
      let eventsToShow = ctx.planner_events_recent;
      if (eventsToShow.length > MAX_EVENTS_IN_PROMPT) {
        const headCount = Math.floor(MAX_EVENTS_IN_PROMPT * 0.1);
        const tailCount = MAX_EVENTS_IN_PROMPT - headCount;
        const head = eventsToShow.slice(0, headCount);
        const tail = eventsToShow.slice(-tailCount);
        eventsToShow = [...head, { type: 'omitted', at: '...', text: '[events omitted]' } as any, ...tail];
      }
      
      for (const ev of eventsToShow) {
        if (ev.type === 'init') {
          lines.push(`<init at="${ev.at}" />`);
        } else if (ev.type === 'asked_user') {
          lines.push(`<planner_asked_user at="${ev.at}">${ev.question}</planner_asked_user>`);
        } else if (ev.type === 'user_message') {
          lines.push(`<user_wrote_to_planner at="${ev.at}">${ev.text}</user_wrote_to_planner>`);
        } else if (ev.type === 'sent_to_agent') {
          const attStr = ev.attachments?.length ? 
            ` attachments="${ev.attachments.map(a=>`${a.name}(${a.mimeType})`).join(', ')}"` : '';
          lines.push(`<planner_wrote_to_agent at="${ev.at}"${attStr}>${ev.text || '(no text)'}</planner_wrote_to_agent>`);
        } else if (ev.type === 'agent_message') {
          lines.push(`<agent_wrote_to_planner at="${ev.at}">${ev.text || '(no text)'}</agent_wrote_to_planner>`);
        } else if (ev.type === 'agent_attachment_added') {
          lines.push(`<agent_sent_file name="${(ev as any).name}" mimeType="${(ev as any).mimeType}" at="${ev.at}" />`);
        } else if (ev.type === 'read_attachment') {
          const r = ev.result;
          if (r.ok && r.text_excerpt) {
            const purposeAttr = ev.purpose ? ` purpose="${ev.purpose}"` : '';
            const truncatedAttr = r.truncated ? ' truncated="true"' : '';
            lines.push(`<planner_read_attachment name="${ev.name}" at="${ev.at}"${purposeAttr}${truncatedAttr}>`);
            lines.push(r.text_excerpt.slice(0, 1000));
            lines.push(`</planner_read_attachment>`);
          } else if (!r.ok) {
            lines.push(`<planner_read_attachment_failed name="${ev.name}" at="${ev.at}" reason="${r.reason || 'unknown'}" />`);
          }
        } else if (ev.type === 'status') {
          // Skip status changes - they're just A2A protocol noise
        } else if (ev.type === 'error') {
          if (ev.code === 'attach_missing') {
            lines.push(`<error code="attach_missing" at="${ev.at}" files="${ev.details.names?.join(', ') || ''}" />`);
          } else if (ev.code === 'send_not_allowed') {
            lines.push(`<error code="send_not_allowed" at="${ev.at}" />`);
          } else {
            lines.push(`<error code="${ev.code}" at="${ev.at}" />`);
          }
        } else if ((ev as any).type === 'omitted') {
          lines.push(`<events_omitted />`);
        }
      }
      
      lines.push("</EVENT_LOG>");
      lines.push("");
    }

    lines.push("<RESPONSE_FORMAT>");
    lines.push("Return exactly ONE ToolCall JSON now (no extra text).");
    lines.push("</RESPONSE_FORMAT>");
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

    // Robust request with up to 3 retries on transient failures
    const url = `${apiBase()}/llm/complete`;
    const maxAttempts = 4; // Allow up to 3 retries for JSON parsing or network failures
    let lastErr: any = null;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let j: any = null;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          let msg = `LLM error: ${res.status}`;
          try { const errJson = await res.json(); if (errJson?.message) msg = String(errJson.message); } catch {}
          // Retry only on server/provider/network classes (5xx)
          if (res.status >= 500 && attempt < maxAttempts) {
            console.warn(`[LLMProvider] attempt ${attempt} failed (${msg}); retrying...`);
            await new Promise((r) => setTimeout(r, 250 * attempt));
            continue;
          }
          throw new Error(msg);
        }
        j = await res.json();
        
        // Try to parse the JSON response
        const text = String(j?.content ?? "");
        console.log("[LLMProvider] LLM response:", text.slice(0, 200));
        if (!text) return { tool: "sleep", args: {} };
        
        try {
          return extractJsonObject(text) as ToolCall;
        } catch (jsonErr: any) {
          // JSON parsing failed - retry if we have attempts left
          if (attempt < maxAttempts) {
            console.warn(`[LLMProvider] attempt ${attempt} failed to parse JSON: ${jsonErr.message}; retrying...`);
            await new Promise((r) => setTimeout(r, 250 * attempt));
            continue;
          }
          throw jsonErr;
        }
      } catch (e: any) {
        lastErr = e;
        const m = String(e?.message ?? e ?? 'error');
        // Network fetch errors should be retried
        if (attempt < maxAttempts && !m.includes('JSON')) {
          console.warn(`[LLMProvider] network/provider error on attempt ${attempt}: ${m}; retrying...`);
          await new Promise((r) => setTimeout(r, 250 * attempt));
          continue;
        }
        throw e;
      }
    }
    
    // Should never reach here, but just in case
    throw lastErr || new Error("Failed to get valid response from LLM");
  }
}
