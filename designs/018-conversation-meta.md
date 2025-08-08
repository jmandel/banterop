# Design 018: Conversation Metadata as Single Source of Truth

## Goals
- **Single source of truth in DB**: Store all conversation attributes once
- **Flexible metadata**: Support arbitrary agent/scenario/runtime fields
- **Zero duplication**: No mirrored "header" fields in separate columns
- **Queryable where needed**: Without back-compat shims

## Core Model

### Database Schema

**Table: `conversations`**
```sql
CREATE TABLE conversations (
  conversation    INTEGER PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  meta_json       TEXT NOT NULL,  -- The entire ConversationMeta (source of truth)
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

**Changes:**
- Drop unused columns: `title`, `description`, `scenario_id` (and their indices)
- Keep only `status` for lifecycle operations
- Everything else lives in `meta_json`

**Table: `conversation_events`**
- Unchanged (append-only event log)

## ConversationMeta Structure (v1)

```typescript
interface ConversationMeta {
  // Core fields
  title?: string;
  description?: string;
  scenarioId?: string;
  
  // Agent configuration (full roster and per-agent config)
  agents: AgentMeta[];
  startingAgentId?: string;
  
  // Configuration
  config?: Record<string, unknown>;  // orchestrator/LLM/policy knobs
  custom?: Record<string, unknown>;  // user/ext fields
  
  // Versioning
  metaVersion: 1;
}

interface AgentMeta {
  id: string;
  kind: 'internal' | 'external';
  agentClass?: string;
  role?: string;
  displayName?: string;
  avatarUrl?: string;
  config?: Record<string, unknown>;
}
```

**Rationale**: Everything a creator passes and a viewer needs is in `meta_json`; no parallel "header" layer.

## API Contracts

### Create Conversation
```typescript
interface CreateConversationRequest {
  meta: ConversationMeta;  // Required, whole object
}
```
- Storage writes `meta_json` as-is
- Status defaults to 'active'
- No convenience aliasing to avoid duplication

### Read Operations
```typescript
// getConversation/getHydratedConversation return:
interface ConversationSnapshot {
  conversation: number;
  status: 'active' | 'completed';
  metadata: ConversationMeta;  // The raw parsed meta_json
  events: UnifiedEvent[];
  lastClosedSeq: number;
}

interface HydratedConversationSnapshot extends ConversationSnapshot {
  scenario: ScenarioConfiguration | null;  // If scenarioId present
}
```
- No synthetic merging or header mirroring
- `metadata` is the parsed `meta_json` verbatim

## Listing & Filtering

### List Conversations
```typescript
interface ListConversationsParams {
  status?: 'active' | 'completed';
  scenarioId?: string;
  limit?: number;
  offset?: number;
}

interface ConversationListItem {
  conversation: number;
  status: 'active' | 'completed';
  updatedAt: string;
  metadata: ConversationMeta;  // Full metadata
}
```

### SQL Filtering
Use SQLite JSON1 functions in WHERE clauses:
```sql
-- Filter by scenarioId
WHERE json_extract(meta_json, '$.scenarioId') = ?

-- Filter by agent kind
WHERE EXISTS (
  SELECT 1 FROM json_each(json_extract(meta_json, '$.agents'))
  WHERE json_extract(value, '$.kind') = 'internal'
)

-- Filter by custom tags (if stored as array)
WHERE EXISTS (
  SELECT 1 FROM json_each(json_extract(meta_json, '$.custom.tags'))
  WHERE value = 'tagX'
)
```

### Indexes
SQLite expression indexes for common queries:
```sql
-- Status + recency (for active/completed listings)
CREATE INDEX idx_convos_status 
  ON conversations(status, updated_at DESC);

-- Scenario filtering
CREATE INDEX idx_convos_scenario 
  ON conversations(json_extract(meta_json, '$.scenarioId'));

-- Add more JSON expression indexes only when required by real queries
```

## Orchestrator Integration

Treat `metadata` as the only conversation config source:
- Policies look at `metadata.agents`, `metadata.startingAgentId`
- Auto-run flags live in `metadata.custom.autoRun`
- No mixing/mirroring of "header" fields
- No "runtimeMeta vs header" split

### Usage Examples
```typescript
// Creating a conversation
orchestrator.createConversation({
  meta: {
    title: "Prior Auth Discussion",
    scenarioId: "prior-auth-v2",
    agents: [
      { id: "nurse", kind: "internal", role: "requester" },
      { id: "payor", kind: "external", role: "reviewer" }
    ],
    startingAgentId: "nurse",
    config: {
      idleTurnMs: 30000,
      maxTurns: 20
    },
    custom: {
      autoRun: true,
      priority: "high",
      tags: ["urgent", "infliximab"]
    },
    metaVersion: 1
  }
});

// Policies consume metadata directly
class ScenarioPolicy {
  decide(snapshot: ConversationSnapshot) {
    const agents = snapshot.metadata.agents;
    const startingAgent = snapshot.metadata.startingAgentId;
    // ... scheduling logic
  }
}
```

## Implementation Checklist

### Storage Layer
- [ ] Update `conversations` table schema (drop title/description/scenario_id)
- [ ] Update ConversationStore methods:
  - [ ] `create()` stores entire meta object as meta_json
  - [ ] `getWithMetadata()` returns parsed meta_json as metadata
  - [ ] `updateMeta()` replaces entire meta_json
  - [ ] `list()` uses json_extract for filtering

### Type Updates
- [ ] Update `ConversationMeta` interface with all fields
- [ ] Remove separate title/description/scenarioId from DB types
- [ ] Update `CreateConversationRequest` to require full meta object

### API Layer
- [ ] HTTP routes consume/return metadata object
- [ ] WebSocket methods use metadata
- [ ] Remove any header field synthesis

### Orchestrator
- [ ] Policies read from metadata only
- [ ] Snapshot building uses metadata
- [ ] Scenario lookup via metadata.scenarioId

## Testing Strategy

### Store Tests
- Create persists meta_json verbatim
- List filters via json_extract work correctly
- updateMeta only mutates meta_json

### Orchestrator Tests
- Snapshots return metadata unchanged from meta_json
- Policies consume startingAgentId and agents from metadata
- Scenario lookup remains by metadata.scenarioId

### API Tests
- Create endpoint accepts full meta object
- List endpoint filters work with JSON expressions
- Get endpoints return metadata correctly

## Tradeoffs

### Pros
- **DRY**: Single source of truth, no duplication
- **Simple mental model**: Everything is in metadata
- **Fewer bugs**: No sync issues between columns and JSON
- **Flexible schema**: Easy to add new fields
- **Clean APIs**: Consistent metadata object everywhere

### Cons
- **Filtering relies on JSON expressions**: Fine for SQLite JSON1, but needs proper indexes
- **Array filters**: Need json_each for complex queries (e.g., tags)
- **No compile-time safety**: Without zod, invalid metadata could be stored (add validation later)

## Future Considerations

1. **Validation**: Add zod schema validation at API boundaries when ready
2. **Migration**: If needed later, can add migration from current dual-storage model
3. **Performance**: Monitor JSON query performance and add indexes as needed
4. **Versioning**: metaVersion field allows future schema evolution