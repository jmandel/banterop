export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

-- Conversations registry (all metadata in meta_json)
CREATE TABLE IF NOT EXISTS conversations (
  conversation    INTEGER PRIMARY KEY,         -- autoincrement id for conversation
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  meta_json       TEXT NOT NULL DEFAULT '{}',  -- JSON string holding all conversation metadata
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_status
  ON conversations (status, updated_at DESC);

-- JSON expression index for scenario filtering
CREATE INDEX IF NOT EXISTS idx_conversations_scenario
  ON conversations (json_extract(meta_json, '$.scenarioId'));

-- Scenarios table to store templates
CREATE TABLE IF NOT EXISTS scenarios (
  id            TEXT PRIMARY KEY,      -- The unique scenarioId, e.g., "prior-auth.v2"
  name          TEXT NOT NULL,         -- A human-friendly name, e.g., "Prior Auth for Infliximab"
  config        TEXT NOT NULL,         -- The full ScenarioConfiguration as a JSON string
  history       TEXT NOT NULL DEFAULT '[]', -- Optional: chat history for a scenario builder UI
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  modified_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scenarios_name ON scenarios (name);

-- Unified event log (append-only)
CREATE TABLE IF NOT EXISTS conversation_events (
  conversation  INTEGER NOT NULL,
  turn          INTEGER NOT NULL,
  event         INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('message','trace','system')),
  payload       TEXT NOT NULL,                 -- JSON string
  finality      TEXT NOT NULL CHECK (finality IN ('none','turn','conversation')),
  ts            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  agent_id      TEXT NOT NULL,
  seq           INTEGER PRIMARY KEY AUTOINCREMENT, -- global total order
  FOREIGN KEY(conversation) REFERENCES conversations(conversation)
);

-- Composite PK for fast scoped addressing
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_conversation_turn_event
  ON conversation_events (conversation, turn, event);

CREATE INDEX IF NOT EXISTS idx_events_conversation_ts
  ON conversation_events (conversation, ts);

-- Attachments table (row-addressed, linked to message event)
CREATE TABLE IF NOT EXISTS attachments (
  id                 TEXT PRIMARY KEY,            -- att_<uuid> or content hash
  conversation       INTEGER NOT NULL,
  turn               INTEGER NOT NULL,
  event              INTEGER NOT NULL,            -- message event that referenced it
  doc_id             TEXT,                        -- logical docId
  name               TEXT NOT NULL,
  content_type       TEXT NOT NULL,
  content            TEXT NOT NULL,
  summary            TEXT,
  created_by_agent_id TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(conversation, turn, event)
    REFERENCES conversation_events(conversation, turn, event)
);

CREATE INDEX IF NOT EXISTS idx_attachments_conversation
  ON attachments (conversation, created_at);

CREATE INDEX IF NOT EXISTS idx_attachments_doc
  ON attachments (conversation, doc_id);

-- Idempotency keys for safe retries
CREATE TABLE IF NOT EXISTS idempotency_keys (
  conversation      INTEGER NOT NULL,
  agent_id          TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  seq               INTEGER NOT NULL,            -- seq of the event written
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (conversation, agent_id, client_request_id)
);

-- Runner registry (server-local ensure state)
CREATE TABLE IF NOT EXISTS runner_registry (
  conversation_id INTEGER NOT NULL,
  agent_id        TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (conversation_id, agent_id)
);


-- Triggers to keep conversations.updated_at fresh
CREATE TRIGGER IF NOT EXISTS trg_conversations_touch AFTER UPDATE ON conversations
BEGIN
  UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation = NEW.conversation;
END;
`;
