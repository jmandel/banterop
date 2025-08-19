export async function* readSSE(resp: Response): AsyncGenerator<string> {
  if (!resp.body) return;
  const reader = (resp.body as any).getReader?.();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  let pendingDataLines: string[] = [];

  const flushEvent = function* () {
    if (pendingDataLines.length) {
      const data = pendingDataLines.join("\n");
      pendingDataLines = [];
      yield data;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      // Support both LF and CRLF record delimiters and advance by the actual length
      const lfIdx = buf.indexOf("\n\n");
      const crlfIdx = buf.indexOf("\r\n\r\n");
      let idx = -1;
      let delimLen = 0;
      if (lfIdx !== -1 && (crlfIdx === -1 || lfIdx < crlfIdx)) {
        idx = lfIdx;
        delimLen = 2;
      } else if (crlfIdx !== -1) {
        idx = crlfIdx;
        delimLen = 4;
      }
      if (idx === -1) break;
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + delimLen);
      const lines = raw.replace(/\r/g, "").split("\n");
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith("data:")) pendingDataLines.push(line.slice(5).trimStart());
        // ignore other SSE fields: event:, id:, retry:
      }
      for (const out of flushEvent()) yield out;
    }
  }
  if (buf.length) {
    const lines = buf.replace(/\r/g, "").split("\n");
    for (const line of lines) {
      if (line.startsWith("data:")) pendingDataLines.push(line.slice(5).trimStart());
    }
  }
  if (pendingDataLines.length) {
    yield pendingDataLines.join("\n");
    pendingDataLines = [];
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
