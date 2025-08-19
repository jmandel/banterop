export const PUBLISHED_TAG = 'published';
const UNLOCK_KEY = 'scenario.edit.unlock';
const TOKEN_KEY = 'scenario.edit.token';
const SHOW_MODE_KEY = 'scenario.showMode';

// 24 hours default TTL
const TTL_MS = 24 * 60 * 60 * 1000;

type UnlockRecord = { unlocked: boolean; ts: number };
type UnlockMap = Record<string, UnlockRecord | undefined>;

export function isPublished(cfg: any): boolean {
  const tags: string[] = cfg?.metadata?.tags || [];
  return tags.includes(PUBLISHED_TAG);
}

export function isUnlockedFor(id?: string, now: number = Date.now()): boolean {
  if (!id) return false;
  try {
    const raw = localStorage.getItem(UNLOCK_KEY) || '{}';
    const m: UnlockMap = JSON.parse(raw);
    const rec = m[id];
    if (!rec || !rec.unlocked) return false;
    return now - rec.ts <= TTL_MS;
  } catch {
    return false;
  }
}

export function setUnlocked(id?: string, v = true) {
  if (!id) return;
  try {
    const raw = localStorage.getItem(UNLOCK_KEY) || '{}';
    const m: UnlockMap = JSON.parse(raw);
    if (v) {
      m[id] = { unlocked: true, ts: Date.now() };
    } else {
      delete m[id];
    }
    localStorage.setItem(UNLOCK_KEY, JSON.stringify(m));
  } catch {}
}

export function clearUnlocked(id?: string) {
  setUnlocked(id, false);
}

export function getEditToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function setEditToken(token: string) {
  try { localStorage.setItem(TOKEN_KEY, token || ''); } catch {}
}

export function clearEditToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
}

export function getShowMode(): 'published' | 'all' {
  try { return (localStorage.getItem(SHOW_MODE_KEY) as any) || 'published'; } catch { return 'published'; }
}

export function setShowMode(mode: 'published' | 'all') {
  try { localStorage.setItem(SHOW_MODE_KEY, mode); } catch {}
}

