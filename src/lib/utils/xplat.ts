// src/lib/utils/xplat.ts
// Cross-runtime (Bun + Browser) helpers for UTF-8 and base64, no Node Buffer/fs

export function textToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function bytesToText(b: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(b);
}

export function bytesToBase64(bytes: Uint8Array): string {
  // btoa expects a binary-string (Latin-1); construct safely
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

export function encodeTextToBase64(s: string): string {
  return bytesToBase64(textToBytes(s));
}

export function decodeBase64ToText(b64: string): string {
  return bytesToText(base64ToBytes(b64));
}

// NOTE: per product decision, we always treat content as text-like
// even if contentType is application/pdf. Keeping a helper in case we
// revisit this later, but it isn't used to block anything.
export function isTextLike(_mime: string): boolean {
  return true; // always treat as text in this project
}
