import { fileToBase64 } from "./a2a-utils";
import { sha256Hex } from "./crypto-utils";

export type AttachmentRecord = {
  name: string;
  mimeType: string;
  bytes: string; // base64
  size: number;
  digest: string; // sha256 of bytes
  source?: 'user' | 'agent' | 'remote-agent';
  summary?: string;
  keywords?: string[];
  last_inspected?: string; // ISO timestamp
  private?: boolean;
  priority?: boolean;
  analysisPending?: boolean;
};

type PersistMeta = Pick<AttachmentRecord, "digest" | "summary" | "keywords" | "last_inspected">;

/**
 * Storage interface for persistence layer
 */
export interface StorageWrapper {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  isAvailable(): boolean;
}

/**
 * localStorage wrapper that handles browser/Node.js compatibility
 */
export class LocalStorageWrapper implements StorageWrapper {
  isAvailable(): boolean {
    return typeof localStorage !== 'undefined';
  }

  getItem(key: string): string | null {
    if (!this.isAvailable()) return null;
    return localStorage.getItem(key);
  }

  setItem(key: string, value: string): void {
    if (!this.isAvailable()) return;
    localStorage.setItem(key, value);
  }

  removeItem(key: string): void {
    if (!this.isAvailable()) return;
    localStorage.removeItem(key);
  }

  clear(): void {
    if (!this.isAvailable()) return;
    localStorage.clear();
  }
}

/**
 * In-memory storage wrapper for Node.js environments
 */
export class InMemoryStorageWrapper implements StorageWrapper {
  private storage = new Map<string, string>();

  isAvailable(): boolean {
    return true;
  }

  getItem(key: string): string | null {
    return this.storage.get(key) || null;
  }

  setItem(key: string, value: string): void {
    this.storage.set(key, value);
  }

  removeItem(key: string): void {
    this.storage.delete(key);
  }

  clear(): void {
    this.storage.clear();
  }
}

const META_KEY = "a2a.attach.meta"; // storage: digest -> {summary, keywords, last_inspected}
const ATTACHMENTS_KEY = "a2a.attachments"; // storage: full attachment records

function loadMetaMap(storage: StorageWrapper): Record<string, PersistMeta> {
  try {
    const raw = storage.getItem(META_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch { return {}; }
}

function saveMetaMap(storage: StorageWrapper, map: Record<string, PersistMeta>): void {
  try {
    storage.setItem(META_KEY, JSON.stringify(map));
  } catch {}
}

export class AttachmentVault {
  private byName = new Map<string, AttachmentRecord>();
  private metaMap: Record<string, PersistMeta>;
  private listeners = new Set<(name?: string) => void>();
  private storage: StorageWrapper;

  constructor(storage: StorageWrapper = new LocalStorageWrapper()) {
    this.storage = storage;
    this.metaMap = loadMetaMap(this.storage);

    // Load from storage if available
    if (this.storage.isAvailable()) {
      this.loadFromStorage();
    } else {
      console.warn('AttachmentVault: Storage not available, using in-memory storage only');
    }
  }

  private loadFromStorage() {
    try {
      const raw = this.storage.getItem(ATTACHMENTS_KEY);
      if (raw) {
        const attachments = JSON.parse(raw) as AttachmentRecord[];
        attachments.forEach(att => {
          this.byName.set(att.name, att);
        });
      }
    } catch (e) {
      console.warn('Failed to load attachments from storage:', e);
    }
  }

  private saveToStorage() {
    try {
      if (!this.storage.isAvailable()) return;
      const attachments = Array.from(this.byName.values());
      this.storage.setItem(ATTACHMENTS_KEY, JSON.stringify(attachments));
    } catch (e) {
      console.warn('Failed to save attachments to storage:', e);
    }
    this.emit();
  }

  listDetailed(): AttachmentRecord[] {
    return [...this.byName.values()];
  }

  listForPlanner(): Array<{ name: string; mimeType: string; size: number; summary?: string; keywords?: string[]; last_inspected?: string; private?: boolean; priority?: boolean }> {
    return this.listDetailed().map(a => ({
      name: a.name, mimeType: a.mimeType, size: a.size,
      summary: a.summary, keywords: a.keywords, last_inspected: a.last_inspected,
      private: a.private, priority: a.priority,
    }));
  }

  listBySource(src: 'user' | 'agent' | 'remote-agent'): AttachmentRecord[] {
    return this.listDetailed().filter(a => (a.source || 'user') === src);
  }

  getByName(name: string): AttachmentRecord | undefined {
    return this.byName.get(name);
  }

  remove(name: string): void {
    this.byName.delete(name);
    this.saveToStorage();
  }

  clear(): void {
    this.byName.clear();
    this.saveToStorage();
  }

  async addFile(file: File): Promise<AttachmentRecord> {
    const bytes = await fileToBase64(file);
    const digest = await sha256Hex(bytes);
    const base: AttachmentRecord = {
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      bytes,
      size: file.size,
      digest,
      source: 'user',
      private: false,
      priority: false,
      analysisPending: false,
    };
    // hydrate from persisted meta if exists
    const persisted = this.metaMap[digest];
    if (persisted) {
      base.summary = persisted.summary;
      base.keywords = persisted.keywords;
      base.last_inspected = persisted.last_inspected;
    }
    this.byName.set(base.name, base);
    this.saveToStorage();
    return base;
  }

  addSynthetic(name: string, mimeType: string, contentUtf8: string): AttachmentRecord {
    // Encode UTF-8 content deterministically to base64
    const utf8 = new TextEncoder().encode(contentUtf8 ?? "");
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < utf8.length; i += chunk) {
      bin += String.fromCharCode(...utf8.subarray(i, i + chunk));
    }
    const bytes = btoa(bin);
    const rec: AttachmentRecord = {
      name, mimeType, bytes, size: utf8.length,
      digest: "", source: 'agent', private: false, priority: false, analysisPending: false
    };
    // synthetic: compute digest too
    sha256Hex(bytes).then(d => { rec.digest = d; });
    this.byName.set(name, rec);
    this.saveToStorage();
    return rec;
  }

  // Add an attachment provided by the remote agent (bytes already base64-encoded)
  addFromAgent(name: string, mimeType: string, bytesBase64: string): AttachmentRecord {
    // Filename-authoritative upsert: replace any existing entry with this name
    const finalName = name;

    const rec: AttachmentRecord = {
      name: finalName, mimeType, bytes: bytesBase64, size: bytesBase64 ? atob(bytesBase64).length : 0,
      digest: "", source: 'remote-agent', private: false, priority: false, analysisPending: false
    };
    // compute digest asynchronously
    if (bytesBase64) {
      sha256Hex(bytesBase64).then(d => { rec.digest = d; });
    }
    this.byName.set(finalName, rec);
    this.saveToStorage();
    return rec;
  }

  // Remove any attachments matching the provided sources (e.g., ['agent','remote-agent'])
  purgeBySource(sources: Array<'user' | 'agent' | 'remote-agent'>) {
    const toDelete: string[] = [];
    for (const [name, rec] of this.byName.entries()) {
      const src = rec.source || 'user';
      if (sources.includes(src)) toDelete.push(name);
    }
    for (const name of toDelete) this.byName.delete(name);
    this.saveToStorage();
  }

  updateFlags(name: string, flags: Partial<Pick<AttachmentRecord, "private" | "priority">>) {
    const rec = this.byName.get(name);
    if (!rec) return;
    Object.assign(rec, flags);
    this.saveToStorage();
  }

  markPending(name: string, on: boolean) {
    const rec = this.byName.get(name);
    if (!rec) return;
    rec.analysisPending = on;
    this.saveToStorage();
  }

  updateSummary(name: string, summary: string, keywords: string[]) {
    const rec = this.byName.get(name);
    if (!rec) return;
    rec.summary = summary;
    rec.keywords = keywords;
    rec.last_inspected = new Date().toISOString();
    if (rec.digest) {
      this.metaMap[rec.digest] = {
        digest: rec.digest,
        summary: rec.summary,
        keywords: rec.keywords,
        last_inspected: rec.last_inspected,
      };
      saveMetaMap(this.storage, this.metaMap);
    }
    this.saveToStorage();
  }

  onChange(fn: (name?: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(name?: string) {
    try { for (const fn of this.listeners) fn(name); } catch {}
  }
}
