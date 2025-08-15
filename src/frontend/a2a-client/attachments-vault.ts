import { fileToBase64 } from "./a2a-utils";
import { sha256Hex } from "./crypto-utils";

export type AttachmentRecord = {
  name: string;
  mimeType: string;
  bytes: string; // base64
  size: number;
  digest: string; // sha256 of bytes
  source?: 'local' | 'agent';
  summary?: string;
  keywords?: string[];
  last_inspected?: string; // ISO timestamp
  private?: boolean;
  priority?: boolean;
  analysisPending?: boolean;
};

type PersistMeta = Pick<AttachmentRecord, "digest" | "summary" | "keywords" | "last_inspected">;
const META_KEY = "a2a.attach.meta"; // localStorage: digest -> {summary, keywords, last_inspected}

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

  listBySource(src: 'local' | 'agent'): AttachmentRecord[] {
    return this.listDetailed().filter(a => (a.source || 'local') === src);
  }

  getByName(name: string): AttachmentRecord | undefined {
    return this.byName.get(name);
  }

  remove(name: string): void {
    this.byName.delete(name);
  }

  clear(): void {
    this.byName.clear();
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
      source: 'local',
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
    return base;
  }

  addSynthetic(name: string, mimeType: string, contentUtf8: string): AttachmentRecord {
    const bytes = btoa(unescape(encodeURIComponent(contentUtf8)));
    const rec: AttachmentRecord = {
      name, mimeType, bytes, size: contentUtf8.length,
      digest: "", source: 'local', private: false, priority: false, analysisPending: false
    };
    // synthetic: compute digest too
    sha256Hex(bytes).then(d => { rec.digest = d; });
    this.byName.set(name, rec);
    return rec;
  }

  // Add an attachment provided by an agent (bytes already base64-encoded)
  addFromAgent(name: string, mimeType: string, bytesBase64: string): AttachmentRecord {
    const rec: AttachmentRecord = {
      name, mimeType, bytes: bytesBase64, size: atob(bytesBase64).length,
      digest: "", source: 'agent', private: false, priority: false, analysisPending: false
    };
    // compute digest asynchronously
    sha256Hex(bytesBase64).then(d => { rec.digest = d; });
    this.byName.set(name, rec);
    return rec;
  }

  updateFlags(name: string, flags: Partial<Pick<AttachmentRecord, "private" | "priority">>) {
    const rec = this.byName.get(name);
    if (!rec) return;
    Object.assign(rec, flags);
  }

  markPending(name: string, on: boolean) {
    const rec = this.byName.get(name);
    if (!rec) return;
    rec.analysisPending = on;
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
  }
}
