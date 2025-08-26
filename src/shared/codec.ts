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

