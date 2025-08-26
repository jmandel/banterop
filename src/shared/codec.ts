export function utf8ToB64(s: string): string {
  try { return btoa(unescape(encodeURIComponent(s))); }
  catch { return Buffer.from(s, 'utf-8').toString('base64'); }
}

export function b64ToUtf8(b64: string, max?: number): string {
  let out: string;
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    out = new TextDecoder('utf-8').decode(arr);
  } catch {
    out = Buffer.from(b64, 'base64').toString('utf-8');
  }
  return typeof max === 'number' ? out.slice(0, max) : out;
}

// Normalize URL-safe base64 and padding for cross-runtime decoding
export function normalizeB64(b64: string): string {
  let s = String(b64 || '');
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (s.length % 4)) % 4;
  if (pad) s = s + '='.repeat(pad);
  return s;
}

// Compute byte length of a base64 string (URL-safe tolerated)
export function b64ByteLength(b64: string): number {
  try {
    // Browser path
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (typeof atob === 'function') {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const bin = atob(normalizeB64(b64));
      return bin.length;
    }
  } catch {}
  try {
    // Node/Bun path
    return Buffer.from(normalizeB64(b64), 'base64').length;
  } catch {}
  return 0;
}
