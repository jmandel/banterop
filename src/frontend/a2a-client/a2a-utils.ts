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
