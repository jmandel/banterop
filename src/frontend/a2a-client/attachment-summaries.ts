import { AttachmentVault } from "./attachments-vault";

function apiBase(): string {
  const win = (globalThis as any)?.window;
  const fromWin = win?.__APP_CONFIG__?.API_BASE;
  return typeof fromWin === "string" && fromWin ? fromWin : "http://localhost:3000/api";
}
async function llmSummarize(model: string | undefined, prompt: string): Promise<{ summary: string; keywords: string[] }> {
  const body: any = {
    messages: [
      { role: "system", content: "You write compact JSON summaries. Output JSON ONLY." },
      { role: "user", content: prompt },
    ],
    maxTokens: 300,
    temperature: 0.2,
  };
  if (model) body.model = model;
  const res = await fetch(`${apiBase()}/llm/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM summarize error: ${res.status}`);
  const j = await res.json();
  const text = String(j?.content ?? "").trim();
  const m = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = (m ? m[1] : text) ?? "";
  try {
    const obj = JSON.parse(raw);
    let summary = String(obj.summary || "").trim();
    let keywords = Array.isArray(obj.keywords) ? obj.keywords.map((s: any) => String(s)).slice(0, 12) : [];
    if (!summary) summary = "(no summary)";
    return { summary, keywords };
  } catch {
    const s = raw.replace(/^["'`]+|["'`]+$/g, "");
    const kw = Array.from(new Set(s.split(/\W+/g).filter(Boolean))).slice(0, 8);
    return { summary: s.slice(0, 240), keywords: kw };
  }
}

function isTexty(mime: string): boolean {
  if (!mime) return false;
  return mime.startsWith("text/") || mime.includes("json") || mime.includes("xml") || mime.includes("csv");
}
function decodeText(b64: string): string {
  try {
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch { return atob(b64); }
}

const MAX_INPUT_CHARS = 12000;

function buildPrompt(name: string, mime: string, text: string): string {
  const head = `File: ${name}\nMIME: ${mime}\n\nBelow is the file content (may be truncated). Provide:\n- "summary": a crisp 1-2 sentence description with salient details.\n- "keywords": 5-12 short tags.\nReturn JSON ONLY: {"summary": "...", "keywords": ["..."]}\n\nCONTENT:\n`;
  let guidance = "";

  const low = `${name} ${mime}`.toLowerCase();
  if (low.includes("contract") || low.includes("agreement") || mime.includes("pdf")) {
    guidance = "Focus on parties, key terms, dates, obligations, and notable clauses.";
  } else if (low.includes("financial") || low.includes("invoice") || low.includes("report") || mime.includes("csv")) {
    guidance = "Highlight metrics, time period, trends, and variances.";
  } else if (low.includes("notes") || low.includes("minutes") || low.includes("meeting")) {
    guidance = "Summarize decisions, action items, owners, and deadlines.";
  } else if (low.includes("roadmap") || low.includes("plan")) {
    guidance = "Summarize milestones, priorities, and risks.";
  } else if (mime.includes("json") || mime.includes("xml")) {
    guidance = "Describe the data shape, notable fields, and any obvious counts.";
  }
  if (guidance) guidance = `\nGuidance: ${guidance}\n`;

  return head + guidance + "\n" + text.slice(0, MAX_INPUT_CHARS);
}

type OnUpdate = (name: string) => void;

export class AttachmentSummarizer {
  private queue: { name: string; priority: boolean }[] = [];
  private running = false;
  private listeners = new Set<OnUpdate>();

  constructor(private getModel: () => string | undefined, private vault: AttachmentVault) {}

  onUpdate(fn: OnUpdate): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(name: string) { for (const fn of this.listeners) fn(name); }

  queueAnalyze(name: string, opts?: { priority?: boolean }) {
    const rec = this.vault.getByName(name);
    if (!rec || rec.private) return;
    this.queue.push({ name, priority: !!opts?.priority });
    this.queue.sort((a, b) => Number(b.priority) - Number(a.priority));
    this.vault.markPending(name, true);
    this.emit(name);
    if (!this.running) { this.running = true; void this.runLoop(); }
  }

  private async runLoop() {
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        const rec = this.vault.getByName(next.name);
        if (!rec) continue;

        try {
          let summary = "";
          let keywords: string[] = [];
          if (isTexty(rec.mimeType)) {
            const text = decodeText(rec.bytes);
            const prompt = buildPrompt(rec.name, rec.mimeType, text);
            const out = await llmSummarize(this.getModel(), prompt);
            summary = out.summary; keywords = out.keywords;
          } else {
            summary = `Binary file (${rec.mimeType}). No content inspection available.`;
            keywords = [rec.mimeType.split("/")[0] || "binary"];
          }
          this.vault.updateSummary(rec.name, summary, keywords);
        } catch (e: any) {
          this.vault.updateSummary(rec.name, `Summary error: ${String(e?.message ?? e)}`, []);
        } finally {
          this.vault.markPending(rec.name, false);
          this.emit(rec.name);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
