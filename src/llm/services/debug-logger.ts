
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import type { LLMRequest, LLMResponse, LLMLoggingMetadata } from '../../types/llm';

function sanitize(s: string) { return s.replace(/[\\/]/g,'_').replace(/\.{2,}/g,'_').replace(/^\.+/,'').replace(/\0/g,'').slice(0,255); }
function baseDir() { return resolve(process.env.LLM_DEBUG_DIR || '/tmp/llm-debug') }

function debugOn() {
  const f = String(process.env.DEBUG_LLM_REQUESTS || '').trim();
  return !!(f && !/^0|false|off$/i.test(f));
}

function makePath(meta?: LLMLoggingMetadata) {
  const root = baseDir();
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  const path = join(root, 'untagged', ts + '-' + Math.random().toString(36).slice(2,6));
  const rel = relative(root, resolve(path));
  if (rel.startsWith('..')) return root;
  return path;
}

export class LLMDebugLogger {
  async logRequest(req: LLMRequest, meta?: LLMLoggingMetadata) {
    if (!debugOn()) return null;
    const p = makePath(meta);
    if (!existsSync(p)) { try { mkdirSync(p, { recursive: true }) } catch { return null } }
    try { await Bun.write(join(p, 'request.txt'), (req.messages||[]).map(m=>`${m.role}:\n${m.content}`).join('\n\n')) } catch {}
    if (meta) { try { await Bun.write(join(p, 'metadata.json'), JSON.stringify(meta,null,2)) } catch {} }
    return p;
  }
  async logResponse(res: LLMResponse, p: string | null) {
    if (!debugOn() || !p) return;
    try { await Bun.write(join(p, 'response.txt'), String(res?.content ?? '')) } catch {}
  }
}

let inst: LLMDebugLogger | null = null;
export function getLLMDebugLogger() { return inst || (inst = new LLMDebugLogger()) }
