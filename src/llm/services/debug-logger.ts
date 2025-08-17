import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import * as path from 'node:path';
import type { LLMRequest, LLMResponse, LLMLoggingMetadata } from '$src/types/llm.types';

function sanitizePathComponent(str: string): string {
  return str
    .replace(/[\/\\]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '')
    .replace(/\0/g, '')
    .slice(0, 255);
}

function generateDebugPath(metadata?: LLMLoggingMetadata): string {
  const baseDir = resolve(process.env.LLM_DEBUG_DIR || '/data/llm-debug');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  if (!metadata || (!metadata.conversationId && !metadata.scenarioId)) {
    if (metadata) {
      console.log(`[LLM Debug] Using untagged - metadata present but missing IDs:`, JSON.stringify(metadata));
    }
    const rand = Math.random().toString(36).slice(2, 8);
    return join(baseDir, 'untagged', `${timestamp}-${rand}`);
  }
  
  const parts: string[] = [baseDir];
  
  if (metadata.conversationId) {
    const safeConvId = sanitizePathComponent(metadata.conversationId);
    parts.push(`conversation_${safeConvId}`);
    
    let dirname = timestamp;
    
    if (metadata.turnNumber !== undefined) {
      dirname += `_turn_${String(metadata.turnNumber).padStart(3, '0')}`;
      if (metadata.agentName) dirname += `_${sanitizePathComponent(metadata.agentName)}`;
      if (metadata.stepDescriptor) dirname += `_${sanitizePathComponent(metadata.stepDescriptor)}`;
    } 
    else {
      if (metadata.agentName) dirname += `_${sanitizePathComponent(metadata.agentName)}`;
      if (metadata.stepDescriptor) dirname += `_${sanitizePathComponent(metadata.stepDescriptor)}`;
    }
    
    parts.push(dirname);
  } 
  else if (metadata.scenarioId) {
    const safeScenarioId = sanitizePathComponent(metadata.scenarioId);
    parts.push('scenario_editor');
    let filename = `${timestamp}_${safeScenarioId}`;
    if (metadata.stepDescriptor) filename += `_${sanitizePathComponent(metadata.stepDescriptor)}`;
    parts.push(filename);
  } 
  else {
    parts.push('partial');
    let dirname = timestamp;
    if (metadata.agentName) dirname = `${sanitizePathComponent(metadata.agentName)}_${dirname}`;
    parts.push(dirname);
  }
  
  const finalPath = resolve(join(...parts));
  
  const relativePath = relative(baseDir, finalPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    console.error(`[LLM Debug] SECURITY: Attempted path traversal detected. Requested path would escape logging directory.`);
    console.error(`[LLM Debug] Base dir: ${baseDir}, Final path: ${finalPath}, Relative: ${relativePath}`);
    const safeRand = Math.random().toString(36).slice(2, 8);
    return join(baseDir, 'security_blocked', `${timestamp}-${safeRand}`);
  }
  
  return finalPath;
}

export class LLMDebugLogger {
  private enabled: boolean;

  constructor() {
    const debugFlag = (process.env.DEBUG_LLM_REQUESTS || '').toString().trim();
    this.enabled = Boolean(debugFlag && !/^0|false|off$/i.test(debugFlag));
  }

  private async ensureLogDirectory(metadata?: LLMLoggingMetadata): Promise<string | null> {
    if (!this.enabled) return null;

    if (metadata) {
      console.log(`[LLM Debug] Request has metadata:`, JSON.stringify(metadata));
    } else {
      console.log(`[LLM Debug] Request has NO metadata`);
    }
    
    const basePath = generateDebugPath(metadata);
    
    if (!existsSync(basePath)) {
      try { 
        mkdirSync(basePath, { recursive: true });
        console.log(`[LLM Debug] Created directory: ${basePath}`);
      } catch (err) {
        console.error(`[LLM Debug] Failed to create directory ${basePath}:`, err);
        return null;
      }
    }

    return basePath;
  }

  async logRequest(request: LLMRequest, metadata?: LLMLoggingMetadata): Promise<string | null> {
    const basePath = await this.ensureLogDirectory(metadata);
    if (!basePath) return null;

    const reqText = (request.messages || [])
      .map((m) => `${m.role}:\n${m.content}`)
      .join('\n\n');
    
    try { 
      await Bun.write(join(basePath, 'request.txt'), reqText);
      console.log(`[LLM Debug] Wrote request to: ${join(basePath, 'request.txt')}`);
    } catch (err) {
      console.error(`[LLM Debug] Failed to write request:`, err);
    }

    if (metadata) {
      try {
        await Bun.write(
          join(basePath, 'metadata.json'), 
          JSON.stringify(metadata, null, 2)
        );
        console.log(`[LLM Debug] Wrote metadata to: ${join(basePath, 'metadata.json')}`);
      } catch (err) {
        console.error(`[LLM Debug] Failed to write metadata:`, err);
      }
    }

    return basePath;
  }

  async logResponse(response: LLMResponse, basePath: string | null): Promise<void> {
    if (!this.enabled || !basePath) return;

    const resText = (response?.content ?? '').toString();
    try { 
      await Bun.write(join(basePath, 'response.txt'), resText);
      console.log(`[LLM Debug] Wrote response to: ${join(basePath, 'response.txt')}`);
    } catch (err) {
      console.error(`[LLM Debug] Failed to write response:`, err);
    }
  }

  async logRequestResponse(
    request: LLMRequest,
    response: LLMResponse,
    metadata?: LLMLoggingMetadata
  ): Promise<void> {
    const basePath = await this.logRequest(request, metadata);
    await this.logResponse(response, basePath);
  }
}

let instance: LLMDebugLogger | null = null;

export function getLLMDebugLogger(): LLMDebugLogger {
  if (!instance) {
    instance = new LLMDebugLogger();
  }
  return instance;
}