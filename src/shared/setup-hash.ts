// Shared helper for encoding/decoding #setup payloads in the URL hash
// Provides tolerant parsing for legacy shapes

export type SetupPayload = {
  v?: number;
  planner?: {
    id?: 'off'|'llm-drafter'|'scenario-v0.3'|'simple-demo';
    mode?: 'approve'|'auto';
    // v1 legacy fields
    ready?: boolean;
    applied?: any;
    config?: any;
    // v2 fields
    seed?: any;
    rev?: number;
  };
  rev?: number; // tolerant legacy placement
  llm?: { model?: string };
  kickoff?: 'if-ready'|'always'|'never';
};

export function encodeSetup(setup: SetupPayload): string {
  try {
    const json = JSON.stringify(setup);
    return `setup=${encodeURIComponent(json)}`;
  } catch {
    return '';
  }
}

export function decodeSetup(hash: string): SetupPayload | null {
  if (!hash) return null;
  const raw = hash.replace(/^#/, '');
  if (!/^setup=/.test(raw)) return null;
  const body = raw.slice('setup='.length);
  // Try URL-decoded JSON
  try {
    const maybe = decodeURIComponent(body);
    if (maybe.trim().startsWith('{')) {
      const obj = JSON.parse(maybe);
      return (obj && (obj as any).setup) ? (obj as any).setup : (obj as any);
    }
  } catch {}
  // Try base64url JSON (legacy), best-effort
  try {
    const norm = body.replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (norm.length % 4)) % 4);
    const b64 = norm + pad;
    // atob is available in browser; for SSR environments, this code path is rarely used
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const json = atob(b64);
    const obj = JSON.parse(json);
    return (obj && (obj as any).setup) ? (obj as any).setup : (obj as any);
  } catch {}
  return null;
}
