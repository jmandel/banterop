import { describe, it, expect, beforeEach } from 'bun:test';
import { isPublished, isUnlockedFor, setUnlocked, clearUnlocked } from './locks';

// Minimal localStorage polyfill for tests
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

describe('locks util', () => {
  beforeEach(() => {
    // @ts-ignore
    globalThis.localStorage = new MemoryStorage();
  });

  it('detects published tag', () => {
    expect(isPublished({ metadata: { tags: ['published'] } })).toBe(true);
    expect(isPublished({ metadata: { tags: ['other'] } })).toBe(false);
    expect(isPublished({ metadata: { } })).toBe(false);
  });

  it('handles unlock with TTL', () => {
    const id = 'abc';
    const now = 1_000_000;
    expect(isUnlockedFor(id, now)).toBe(false);
    setUnlocked(id, true);
    // Using recorded ts, use current time to verify true
    expect(isUnlockedFor(id, Date.now())).toBe(true);
    // Simulate future after >24h: now + 24h + 1ms
    const dayMs = 24 * 60 * 60 * 1000;
    expect(isUnlockedFor(id, Date.now() + dayMs + 1)).toBe(false);
    // Clear
    clearUnlocked(id);
    expect(isUnlockedFor(id, Date.now())).toBe(false);
  });
});

