import { AttachmentVault } from "./attachments-vault";

function apiBase(): string {
  const win = (globalThis as any)?.window;
  const fromWin = win?.__APP_CONFIG__?.API_BASE;
  return typeof fromWin === "string" && fromWin ? fromWin : "http://localhost:3000/api";
}
async function llmSummarize(model: string | undefined, prompt: string): Promise<{ summary: string; keywords: string[] }> {
  const body: any = {
    messages: [
      { role: "system", content: "You are a document analyzer. You MUST respond with valid JSON only, no other text. Your response must be a JSON object with exactly two fields: 'summary' (string) and 'keywords' (array of strings)." },
      { role: "user", content: prompt },
    ],
    maxTokens: 300,
    temperature: 0.2,
  };
  if (model) body.model = model;
  const url = `${apiBase()}/llm/complete`;
  const maxAttempts = 3; // initial + 2 retries
  let j: any = null;
  let lastErr: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = `LLM summarize error: ${res.status}`;
        try { const errJson = await res.json(); if (errJson?.message) msg = String(errJson.message); } catch {}
        if (res.status >= 500 && attempt < maxAttempts) {
          console.warn(`[Summarizer] attempt ${attempt} failed (${msg}); retrying...`);
          await new Promise((r) => setTimeout(r, 250 * attempt));
          continue;
        }
        throw new Error(msg);
      }
      j = await res.json();
      break;
    } catch (e: any) {
      lastErr = e;
      const m = String(e?.message ?? e ?? 'error');
      if (attempt < maxAttempts) {
        console.warn(`[Summarizer] network/provider error on attempt ${attempt}: ${m}; retrying...`);
        await new Promise((r) => setTimeout(r, 250 * attempt));
        continue;
      }
      throw e;
    }
  }
  let text = String(j?.content ?? "").trim();
  
  // Try multiple parsing strategies
  // 1. Check for markdown code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    text = codeBlockMatch[1].trim();
  }
  
  // 2. Find JSON object in the text
  const jsonMatch = text.match(/{[^{}]*"summary"[^{}]*}/s);
  if (jsonMatch) {
    text = jsonMatch[0];
  }
  
  try {
    const obj = JSON.parse(text);
    
    // Validate the response structure
    if (typeof obj !== 'object' || !obj || !obj.summary) {
      throw new Error('Invalid response structure');
    }
    
    let summary = String(obj.summary || "").trim();
    let keywords = Array.isArray(obj.keywords) 
      ? obj.keywords.filter((k: any) => typeof k === 'string').map((s: any) => String(s).trim()).slice(0, 12) 
      : [];
    
    // Clean up summary if it's too long or contains JSON
    if (summary.length > 200 || summary.includes('{') || summary.includes('[')) {
      summary = summary.substring(0, 200).replace(/[{\[].*/, '').trim();
    }
    
    if (!summary) summary = "File analyzed but no summary generated";
    
    return { summary, keywords };
  } catch (parseError) {
    console.warn('[Summarizer] Failed to parse AI response as JSON:', text.substring(0, 200));
    // Fallback: treat the whole response as the summary if it's not JSON
    const cleanText = text.replace(/[{\["'`].*$/s, '').replace(/^["'`]+|["'`]+$/g, '').trim();
    if (cleanText && cleanText.length < 200 && !cleanText.includes('{')) {
      return { summary: cleanText, keywords: [] };
    }
    return { summary: "Failed to analyze file content", keywords: [] };
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
  const head = `Analyze this file and return ONLY a JSON object (no markdown, no explanation, just the JSON):

File: ${name}
MIME: ${mime}

Required JSON format:
{
  "summary": "One clear sentence describing the file content and purpose",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}

IMPORTANT: Return ONLY the JSON object, nothing else.

FILE CONTENT:
`;
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
