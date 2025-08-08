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
  kind: z.enum(['internal', 'external']),
  agentClass: z.string().optional(),       // e.g. "ScenarioDrivenAgent", "AssistantAgent", "EchoAgent", "ScriptAgent"
  role: z.string().optional(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
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
 */
export function decodeBase64Url<T = unknown>(b64url: string): T {
  const normalized = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const json = Buffer.from(normalized + pad, 'base64').toString('utf8');
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
 *  2) If exactly one external agent exists, use that one
 *  3) Fallback: first agent id
 */
export function getStartingAgentId(meta: ConvConversationMeta): string {
  if (meta.startingAgentId) return meta.startingAgentId;
  const externals = meta.agents.filter(a => a.kind === 'external');
  if (externals.length === 1) return externals[0]!.id;
  return meta.agents[0]!.id;
}