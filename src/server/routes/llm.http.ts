import { Hono } from 'hono';
import { z } from 'zod';
import type { LLMProviderManager } from '$src/llm/provider-manager';
import type { LLMRequest, LLMResponse, SupportedProvider, LLMLoggingMetadata } from '$src/types/llm.types';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import * as path from 'node:path';

const LLMMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

const LLMToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.unknown()).default({}),
});

const LLMLoggingMetadataSchema = z.object({
  conversationId: z.string().optional(),
  agentName: z.string().optional(),
  turnNumber: z.number().optional(),
  scenarioId: z.string().optional(),
  stepDescriptor: z.string().optional(),
  requestId: z.string().optional(),
}).optional();

const LLMCompleteSchema = z.object({
  messages: z.array(LLMMessageSchema).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  tools: z.array(LLMToolSchema).optional(),
  loggingMetadata: LLMLoggingMetadataSchema,
  // Server-side override: which configured provider to use (no apiKey from clients)
  provider: z.enum(['google', 'openrouter', 'mock', 'browserside']).optional(),
});

// Sanitize string to prevent directory traversal
function sanitizePathComponent(str: string): string {
  // Remove any path separators and parent directory references
  return str
    .replace(/[\/\\]/g, '_')  // Replace slashes with underscores
    .replace(/\.\./g, '_')     // Replace .. with underscore
    .replace(/^\.+/, '')       // Remove leading dots
    .replace(/\0/g, '')        // Remove null bytes
    .slice(0, 255);            // Limit length for filesystem compatibility
}

function generateDebugPath(metadata?: LLMLoggingMetadata): string {
  const baseDir = resolve(process.env.LLM_DEBUG_DIR || '/data/llm-debug');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  if (!metadata || (!metadata.conversationId && !metadata.scenarioId)) {
    // Log why we're using untagged
    if (metadata) {
      console.log(`[LLM Debug] Using untagged - metadata present but missing IDs:`, JSON.stringify(metadata));
    }
    const rand = Math.random().toString(36).slice(2, 8);
    return join(baseDir, 'untagged', `${timestamp}-${rand}`);
  }
  
  const parts: string[] = [baseDir];
  
  // Conversation-related calls (including tool synthesis)
  if (metadata.conversationId) {
    const safeConvId = sanitizePathComponent(metadata.conversationId);
    parts.push(`conversation_${safeConvId}`);
    
    // Put timestamp first for chronological sorting within conversation folder
    let dirname = timestamp;
    
    // Regular turn with turn number
    if (metadata.turnNumber !== undefined) {
      dirname += `_turn_${String(metadata.turnNumber).padStart(3, '0')}`;
      if (metadata.agentName) dirname += `_${sanitizePathComponent(metadata.agentName)}`;
      if (metadata.stepDescriptor) dirname += `_${sanitizePathComponent(metadata.stepDescriptor)}`;
    } 
    // Tool synthesis or other conversation-related calls without turn number
    else {
      if (metadata.agentName) dirname += `_${sanitizePathComponent(metadata.agentName)}`;
      if (metadata.stepDescriptor) dirname += `_${sanitizePathComponent(metadata.stepDescriptor)}`;
    }
    
    parts.push(dirname);
  } 
  // Scenario editor calls (not part of a conversation)
  else if (metadata.scenarioId) {
    const safeScenarioId = sanitizePathComponent(metadata.scenarioId);
    parts.push('scenario_editor');
    // Use flat structure like conversations - timestamp first for sorting
    let filename = `${timestamp}_${safeScenarioId}`;
    if (metadata.stepDescriptor) filename += `_${sanitizePathComponent(metadata.stepDescriptor)}`;
    parts.push(filename);
  } 
  // Partial metadata fallback
  else {
    parts.push('partial');
    let dirname = timestamp;
    if (metadata.agentName) dirname = `${sanitizePathComponent(metadata.agentName)}_${dirname}`;
    parts.push(dirname);
  }
  
  // Build the final path
  const finalPath = resolve(join(...parts));
  
  // CRITICAL SECURITY CHECK: Ensure the final path is within the base directory
  // This prevents any path traversal attacks that might bypass sanitization
  const relativePath = relative(baseDir, finalPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    // Path would escape the base directory - use a safe fallback
    console.error(`[LLM Debug] SECURITY: Attempted path traversal detected. Requested path would escape logging directory.`);
    console.error(`[LLM Debug] Base dir: ${baseDir}, Final path: ${finalPath}, Relative: ${relativePath}`);
    const safeRand = Math.random().toString(36).slice(2, 8);
    return join(baseDir, 'security_blocked', `${timestamp}-${safeRand}`);
  }
  
  return finalPath;
}

export function createLLMRoutes(pm: LLMProviderManager) {
  const app = new Hono();

  // GET providers metadata
  app.get('/llm/providers', (c) => {
    const providers = pm.getAvailableProviders();
    return c.json(providers);
  });

  // POST completion (synchronous, non-streaming)
  app.post('/llm/complete', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = LLMCompleteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'ValidationError', details: parsed.error.flatten() }, 400);
    }

    const input = parsed.data;
    try {
      const provider = pm.getProvider({
        ...(input.provider ? { provider: input.provider as SupportedProvider } : {}),
        ...(input.model ? { model: input.model } : {}),
      });

      // Build LLMRequest for the provider
      const req: LLMRequest = {
        messages: input.messages,
        ...(input.model ? { model: input.model } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
      };

      // Optional debug logging of request/response to files
      const debugFlag = (process.env.DEBUG_LLM_REQUESTS || '').toString().trim();
      const debugEnabled = debugFlag && !/^0|false|off$/i.test(debugFlag);
      let basePath: string | null = null;
      if (debugEnabled) {
        basePath = generateDebugPath(input.loggingMetadata);
        // basePath is now a directory, not a file prefix
        if (!existsSync(basePath)) {
          try { 
            mkdirSync(basePath, { recursive: true });
            console.log(`[LLM Debug] Created directory: ${basePath}`);
          } catch (err) {
            console.error(`[LLM Debug] Failed to create directory ${basePath}:`, err);
          }
        }
        const reqText = (input.messages || [])
          .map((m) => `${m.role}:\n${m.content}`)
          .join('\n\n');
        try { 
          await Bun.write(join(basePath, 'request.txt'), reqText);
          console.log(`[LLM Debug] Wrote request to: ${join(basePath, 'request.txt')}`);
        } catch (err) {
          console.error(`[LLM Debug] Failed to write request:`, err);
        }
      }

      const result: LLMResponse = await provider.complete(req);

      if (debugEnabled && basePath) {
        const resText = (result?.content ?? '').toString();
        try { 
          await Bun.write(join(basePath, 'response.txt'), resText);
          console.log(`[LLM Debug] Wrote response to: ${join(basePath, 'response.txt')}`);
        } catch (err) {
          console.error(`[LLM Debug] Failed to write response:`, err);
        }
        
        // Write metadata file
        if (input.loggingMetadata) {
          try {
            await Bun.write(
              join(basePath, 'metadata.json'), 
              JSON.stringify(input.loggingMetadata, null, 2)
            );
            console.log(`[LLM Debug] Wrote metadata to: ${join(basePath, 'metadata.json')}`);
          } catch (err) {
            console.error(`[LLM Debug] Failed to write metadata:`, err);
          }
        }
      }
      return c.json(result, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Provider error';
      // Provider/network/API error -> 502
      return c.json({ error: 'ProviderError', message }, 502);
    }
  });

  return app;
}