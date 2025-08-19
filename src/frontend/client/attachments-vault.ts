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
const META_KEY = "a2a.attach.meta"; // localStorage: digest -> {summary, keywords, last_inspected}
const ATTACHMENTS_KEY = "a2a.attachments"; // localStorage: full attachment records

function loadMetaMap(): Record<string, PersistMeta> {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch { return {}; }
}
function saveMetaMap(map: Record<string, PersistMeta>) {
  try { localStorage.setItem(META_KEY, JSON.stringify(map)); } catch {}
}

export class AttachmentVault {
  private byName = new Map<string, AttachmentRecord>();
  private metaMap = loadMetaMap();

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage() {
    try {
      const raw = localStorage.getItem(ATTACHMENTS_KEY);
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
      const attachments = Array.from(this.byName.values());
      localStorage.setItem(ATTACHMENTS_KEY, JSON.stringify(attachments));
    } catch (e) {
      console.warn('Failed to save attachments to storage:', e);
    }
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
    // Demo policy: filenames are unique. If it already exists, do not re-add.
    if (this.byName.has(name)) {
      return this.byName.get(name)!;
    }
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
      saveMetaMap(this.metaMap);
    }
    this.saveToStorage();
  }
}
