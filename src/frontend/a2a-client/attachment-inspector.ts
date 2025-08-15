import { AttachmentVault } from "./attachments-vault";

export type InspectionResult = {
  ok: boolean;
  name: string;
  mimeType: string;
  size: number;
  reason?: string;         // present when ok=false
  private?: boolean;
  text?: string;           // full or truncated text content for text-like files
  truncated?: boolean;     // true if text was truncated
  description?: string;    // fallback description for binaries / unsupported types
};

const MAX_CHARS = 32000; // keep prompt-safe

function isTexty(mime: string): boolean {
  if (!mime) return false;
  return (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("csv")
  );
}

function decodeTextFromBase64(b64: string): string {
  try {
    const raw = atob(b64);
    // best-effort UTF-8 decode
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    // fallback Latin-1
    return atob(b64);
  }
}

export async function inspectAttachment(vault: AttachmentVault, name: string, purpose?: string): Promise<InspectionResult> {
  const rec = vault.getByName(name);
  if (!rec) {
    return { ok: false, name, mimeType: "unknown", size: 0, reason: "Attachment not found" };
  }
  if (rec.private) {
    return { ok: false, name: rec.name, mimeType: rec.mimeType, size: rec.size, private: true, reason: "Attachment marked private" };
  }
  if (isTexty(rec.mimeType)) {
    const full = decodeTextFromBase64(rec.bytes);
    if (full.length <= MAX_CHARS) {
      return { ok: true, name: rec.name, mimeType: rec.mimeType, size: rec.size, text: full, truncated: false };
    }
    return { ok: true, name: rec.name, mimeType: rec.mimeType, size: rec.size, text: full.slice(0, MAX_CHARS), truncated: true };
  }
  const desc = `Binary file (${rec.mimeType}); content inspection not available in-browser${purpose ? `; purpose: ${purpose}` : ""}.`;
  return { ok: true, name: rec.name, mimeType: rec.mimeType, size: rec.size, description: desc };
}
