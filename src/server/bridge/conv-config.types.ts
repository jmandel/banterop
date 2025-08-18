// src/server/bridge/conv-config.types.ts
//
// Base64URL-encoded conversation configuration (generic, not MCP-specific)
// This is essentially a ConversationMeta payload from src/types/conversation.meta.ts,
// encoded as base64url for transport. We validate with zod and provide helpers.
//
// Usage:
//   const meta = parseConversationMetaFromConfig64(config64);
//   const startingId = getStartingAgentId(meta);
//   const internalIds = listInternalAgentIds(meta);
//

import { z } from 'zod';

// Zod schemas mirroring ConversationMeta/AgentMeta shape but validation-friendly
const AgentMetaSchema = z.object({
  id: z.string(),
  agentClass: z.string().optional(),       // e.g. "ScenarioDrivenAgent", "AssistantAgent", "EchoAgent", "ScriptAgent"
  // role, displayName, avatarUrl removed
  config: z.record(z.unknown()).optional(),// agent-specific runtime config (LLM provider settings, script steps, etc.)
});

const ConversationMetaSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  scenarioId: z.string().optional(),
  agents: z.array(AgentMetaSchema).min(1),
  startingAgentId: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  custom: z.record(z.unknown()).optional(),
});

export type ConvAgentMeta = z.infer<typeof AgentMetaSchema>;
export type ConvConversationMeta = z.infer<typeof ConversationMetaSchema>;

/**
 * Decode base64url (RFC 4648) JSON string to object.
 * NOTE: atob is available in both browser and Bun environments.
 */
export function decodeBase64Url<T = unknown>(b64url: string): T {
  const normalized = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const base64 = normalized + pad;
  // Decode base64 to bytes, then UTF‑8 string (avoid Latin‑1 mojibake)
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const json = new TextDecoder('utf-8').decode(bytes);
  return JSON.parse(json) as T;
}

/**
 * Parse config64 into a validated ConversationMeta-like object.
 */
export function parseConversationMetaFromConfig64(config64: string): ConvConversationMeta {
  const raw = decodeBase64Url<unknown>(config64);
  const parsed = ConversationMetaSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid conversation meta config: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Determine which agent should start the conversation.
 * Priority:
 *  1) meta.startingAgentId
 *  2) Fallback: first agent id
 */
export function getStartingAgentId(meta: ConvConversationMeta): string {
  if (meta.startingAgentId) return meta.startingAgentId;
  return meta.agents[0]!.id;
}
