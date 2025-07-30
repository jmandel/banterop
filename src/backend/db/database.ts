// Database Schema and Repository Implementation

import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import { 
  Conversation, ConversationTurn, TraceEntry, AgentId,
  ConversationRow, ConversationTurnRow, TraceEntryRow, 
  UserQueryRow, AgentTokenRow, AgentConfig, ScenarioRow,
  ScenarioVersionRow, ScenarioConfiguration, ScenarioItem
} from '$lib/types.js';

export class ConversationDatabase {
  private db: Database;

  constructor(dbPath: string = './dbs/conversations.db') {
    // Use in-memory database if dbPath is ':memory:' or if in test environment
    const isTest = process.env.NODE_ENV === 'test' || dbPath.includes('test-');
    const finalPath = isTest && dbPath !== ':memory:' ? ':memory:' : dbPath;
    
    // Ensure dbs directory exists for persistent databases
    if (finalPath !== ':memory:' && finalPath.startsWith('./dbs/')) {
      try {
        if (!fs.existsSync('./dbs')) {
          fs.mkdirSync('./dbs', { recursive: true });
        }
      } catch (e) {
        // Fallback if fs is not available
      }
    }
    
    this.db = new Database(finalPath);
    this.initializeSchema();
  }

  private initializeSchema() {
    // Enable foreign keys
    this.db.exec('PRAGMA foreign_keys = ON');

    // Conversations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        name TEXT,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata TEXT,
        agents TEXT NOT NULL
      )
    `);

    // Conversation turns table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        is_final_turn INTEGER DEFAULT 0,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `);

    // Create index for efficient turn retrieval
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_turns_conversation 
      ON conversation_turns(conversation_id, timestamp)
    `);

    // Trace entries table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trace_entries (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        turn_id TEXT,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id),
        FOREIGN KEY (turn_id) REFERENCES conversation_turns(id)
      )
    `);

    // Create index for trace retrieval
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trace_conversation 
      ON trace_entries(conversation_id, timestamp)
    `);

    // User queries table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_queries (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        question TEXT NOT NULL,
        context TEXT,
        status TEXT NOT NULL,
        response TEXT,
        responded_at TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `);

    // Agent tokens table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tokens (
        token TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `);

    // Create index for token lookup
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tokens_expiry 
      ON agent_tokens(expires_at)
    `);

    // Scenarios table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scenarios (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT
      )
    `);

    // Scenario versions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scenario_versions (
        id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        configuration TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_active BOOLEAN DEFAULT false,
        FOREIGN KEY (scenario_id) REFERENCES scenarios(id),
        UNIQUE(scenario_id, version_number)
      )
    `);

    // Create indices for scenario lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scenario_versions_scenario 
      ON scenario_versions(scenario_id, version_number DESC)
    `);
    
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scenario_versions_active 
      ON scenario_versions(scenario_id, is_active)
    `);
  }

  // ============= Conversation Methods =============

  createConversation(conversation: Conversation): void {
    const stmt = this.db.prepare(`
      INSERT INTO conversations (id, name, created_at, status, metadata, agents)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      conversation.id,
      conversation.name || null,
      conversation.createdAt.toISOString(),
      conversation.status,
      JSON.stringify(conversation.metadata || {}),
      JSON.stringify(conversation.agents)
    );
  }

  getConversation(id: string, includeTurns = true, includeTrace = false): Conversation | null {
    const stmt = this.db.prepare(`
      SELECT * FROM conversations WHERE id = ?
    `);

    const row = stmt.get(id) as ConversationRow | undefined;
    if (!row) return null;

    return this.conversationFromRow(row, includeTurns, includeTrace);
  }

  getAllConversations(options?: { 
    limit?: number; 
    offset?: number; 
    includeTurns?: boolean; 
    includeTrace?: boolean;
  }): { conversations: Conversation[]; total: number } {
    const { limit = 50, offset = 0, includeTurns = false, includeTrace = false } = options || {};

    // Get total count
    const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM conversations');
    const { count: total } = countStmt.get() as { count: number };

    // Get conversations with pagination
    const stmt = this.db.prepare(`
      SELECT * FROM conversations 
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(limit, offset) as ConversationRow[];
    const conversations = rows.map(row => this.conversationFromRow(row, includeTurns, includeTrace));

    return { conversations, total };
  }

  updateConversationStatus(id: string, status: string): void {
    const stmt = this.db.prepare(`
      UPDATE conversations SET status = ? WHERE id = ?
    `);
    stmt.run(status, id);
  }

  // ============= Turn Methods =============

  startTurn(turnId: string, conversationId: string, agentId: string, metadata?: Record<string, any>): void {
    const stmt = this.db.prepare(`
      INSERT INTO conversation_turns 
      (id, conversation_id, agent_id, timestamp, content, metadata, status, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    stmt.run(
      turnId,
      conversationId,
      agentId,
      now,
      '', // Content will be filled when turn is completed
      metadata ? JSON.stringify(metadata) : null,
      'in_progress',
      now,
      null
    );
  }

  completeTurn(turnId: string, content: string, isFinalTurn?: boolean): void {
    const stmt = this.db.prepare(`
      UPDATE conversation_turns 
      SET content = ?, status = 'completed', completed_at = ?, is_final_turn = ?
      WHERE id = ? AND status = 'in_progress'
    `);

    stmt.run(
      content,
      new Date().toISOString(),
      isFinalTurn ? 1 : 0,
      turnId
    );
  }

  addTurn(turn: ConversationTurn): void {
    const stmt = this.db.prepare(`
      INSERT INTO conversation_turns 
      (id, conversation_id, agent_id, timestamp, content, metadata, status, started_at, completed_at, is_final_turn)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      turn.id,
      turn.conversationId,
      turn.agentId,
      turn.timestamp.toISOString(),
      turn.content,
      turn.metadata ? JSON.stringify(turn.metadata) : null,
      turn.status,
      turn.startedAt.toISOString(),
      turn.completedAt?.toISOString() || null,
      turn.isFinalTurn ? 1 : 0
    );
  }

  updateTurnStatus(turnId: string, status: string): void {
    const stmt = this.db.prepare(`
      UPDATE conversation_turns 
      SET status = ?
      WHERE id = ?
    `);
    stmt.run(status, turnId);
  }

  getInProgressTurns(conversationId: string): ConversationTurn[] {
    const stmt = this.db.prepare(`
      SELECT * FROM conversation_turns 
      WHERE conversation_id = ? AND status = 'in_progress'
      ORDER BY started_at ASC
    `);

    const rows = stmt.all(conversationId) as ConversationTurnRow[];
    return rows.map(this.turnFromRow);
  }

  getTurns(conversationId: string, includeTrace = false, limit?: number): ConversationTurn[] {
    const query = limit
      ? `SELECT * FROM conversation_turns WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT ?`
      : `SELECT * FROM conversation_turns WHERE conversation_id = ? ORDER BY timestamp ASC`;

    const stmt = this.db.prepare(query);
    const rows = limit 
      ? stmt.all(conversationId, limit) as ConversationTurnRow[]
      : stmt.all(conversationId) as ConversationTurnRow[];

    const turns = rows.map(row => this.turnFromRow(row));

    if (includeTrace) {
      // Fetch traces for all turns in one query
      const turnIds = turns.map(t => t.id);
      if (turnIds.length > 0) {
        const placeholders = turnIds.map(() => '?').join(',');
        const traceStmt = this.db.prepare(`
          SELECT * FROM trace_entries 
          WHERE turn_id IN (${placeholders})
          ORDER BY timestamp ASC
        `);
        const traceRows = traceStmt.all(...turnIds) as TraceEntryRow[];
        
        // Group traces by turn_id
        const tracesByTurn = new Map<string, TraceEntry[]>();
        traceRows.forEach(row => {
          const trace = JSON.parse(row.data) as TraceEntry;
          const turnTraces = tracesByTurn.get(row.turn_id!) || [];
          turnTraces.push(trace);
          tracesByTurn.set(row.turn_id!, turnTraces);
        });

        // Attach traces to turns
        turns.forEach(turn => {
          turn.trace = tracesByTurn.get(turn.id) || [];
        });
      }
    }

    return turns;
  }

  getTurn(turnId: string, includeTrace = false): ConversationTurn | null {
    const stmt = this.db.prepare(`SELECT * FROM conversation_turns WHERE id = ?`);
    const row = stmt.get(turnId) as ConversationTurnRow | undefined;
    
    if (!row) {
      return null;
    }

    const turn = this.turnFromRow(row);

    if (includeTrace) {
      turn.trace = this.getTraceEntriesForTurn(turnId);
    }

    return turn;
  }

  // ============= Trace Methods =============

  addTraceEntry(conversationId: string, entry: TraceEntry, turnId?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO trace_entries (id, conversation_id, agent_id, turn_id, timestamp, type, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Handle timestamp - might be Date object or ISO string
    const timestamp = entry.timestamp instanceof Date ? entry.timestamp.toISOString() : entry.timestamp;

    stmt.run(
      entry.id,
      conversationId,
      entry.agentId,
      turnId || null,
      timestamp,
      entry.type,
      JSON.stringify(entry)
    );
  }

  addTraceEntries(conversationId: string, entries: TraceEntry[], turnId?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO trace_entries (id, conversation_id, agent_id, turn_id, timestamp, type, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((entries: TraceEntry[]) => {
      for (const entry of entries) {
        // Handle timestamp - might be Date object or ISO string
        const timestamp = entry.timestamp instanceof Date ? entry.timestamp.toISOString() : entry.timestamp;
        
        stmt.run(
          entry.id,
          conversationId,
          entry.agentId,
          turnId || null,
          timestamp,
          entry.type,
          JSON.stringify(entry)
        );
      }
    });

    insertMany(entries);
  }

  updateTraceEntriesTurn(traceIds: string[], turnId: string): void {
    const placeholders = traceIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      UPDATE trace_entries 
      SET turn_id = ?
      WHERE id IN (${placeholders})
    `);

    stmt.run(turnId, ...traceIds);
  }

  getTraceEntriesForTurn(turnId: string): TraceEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM trace_entries 
      WHERE turn_id = ?
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(turnId) as TraceEntryRow[];
    return rows.map(row => JSON.parse(row.data) as TraceEntry);
  }

  getTraceEntries(conversationId: string, traceIds: string[]): TraceEntry[] {
    const placeholders = traceIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT * FROM trace_entries 
      WHERE conversation_id = ? AND id IN (${placeholders})
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(conversationId, ...traceIds) as TraceEntryRow[];
    return rows.map(row => JSON.parse(row.data) as TraceEntry);
  }

  getAllTraceEntries(conversationId: string): TraceEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM trace_entries 
      WHERE conversation_id = ?
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(conversationId) as TraceEntryRow[];
    return rows.map(row => JSON.parse(row.data) as TraceEntry);
  }

  // ============= User Query Methods =============

  createUserQuery(query: {
    id: string;
    conversationId: string;
    agentId: string;
    question: string;
    context?: Record<string, any>;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO user_queries 
      (id, conversation_id, agent_id, created_at, question, context, status, response, responded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      query.id,
      query.conversationId,
      query.agentId,
      new Date().toISOString(),
      query.question,
      query.context ? JSON.stringify(query.context) : null,
      'pending',
      null,
      null
    );
  }

  updateUserQueryResponse(queryId: string, response: string): void {
    const stmt = this.db.prepare(`
      UPDATE user_queries 
      SET status = ?, response = ?, responded_at = ?
      WHERE id = ?
    `);

    stmt.run('answered', response, new Date().toISOString(), queryId);
  }

  getUserQuery(queryId: string): UserQueryRow | null {
    const stmt = this.db.prepare(`
      SELECT * FROM user_queries WHERE id = ?
    `);

    return stmt.get(queryId) as UserQueryRow | null;
  }

  getPendingUserQueries(conversationId: string): UserQueryRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM user_queries 
      WHERE conversation_id = ? AND status = 'pending'
      ORDER BY created_at ASC
    `);

    return stmt.all(conversationId) as UserQueryRow[];
  }

  /**
   * Get all pending user queries across the entire system
   * Used by E2E tests and monitoring tools to detect queries needing responses
   */
  getAllPendingUserQueries(): UserQueryRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM user_queries 
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `);
    
    return stmt.all() as UserQueryRow[];
  }

  // ============= Token Methods =============

  createAgentToken(token: string, conversationId: string, agentId: string, expiresIn: number = 86400000): void {
    const stmt = this.db.prepare(`
      INSERT INTO agent_tokens (token, conversation_id, agent_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresIn);

    stmt.run(
      token,
      conversationId,
      agentId,
      now.toISOString(),
      expiresAt.toISOString()
    );
  }

  validateToken(token: string): { conversationId: string; agentId: string } | null {
    const stmt = this.db.prepare(`
      SELECT * FROM agent_tokens 
      WHERE token = ? AND expires_at > ?
    `);

    const row = stmt.get(token, new Date().toISOString()) as AgentTokenRow | undefined;
    if (!row) return null;

    return {
      conversationId: row.conversation_id,
      agentId: row.agent_id
    };
  }

  cleanupExpiredTokens(): void {
    const stmt = this.db.prepare(`
      DELETE FROM agent_tokens WHERE expires_at <= ?
    `);
    stmt.run(new Date().toISOString());
  }

  // ============= Helper Methods =============

  private conversationFromRow(row: ConversationRow, includeTurns = true, includeTrace = false): Conversation {
    const conversation: Conversation = {
      id: row.id,
      name: row.name || undefined,
      createdAt: new Date(row.created_at),
      agents: JSON.parse(row.agents),
      turns: [],
      status: row.status as any,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    };

    if (includeTurns) {
      conversation.turns = this.getTurns(row.id, includeTrace);
    }

    return conversation;
  }

  private turnFromRow(row: ConversationTurnRow): ConversationTurn {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      timestamp: new Date(row.timestamp),
      content: row.content,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      status: row.status as any,
      startedAt: new Date(row.started_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      trace: [], // Initialize empty trace array
      isFinalTurn: Boolean(row.is_final_turn)
    };
  }

  // ============= Scenario Methods =============

  findScenarioById(scenarioId: string): ScenarioItem | null {
    const scenarioStmt = this.db.prepare(`
      SELECT * FROM scenarios WHERE id = ?
    `);
    const scenarioRow = scenarioStmt.get(scenarioId) as ScenarioRow | undefined;
    
    if (!scenarioRow) {
      return null;
    }

    // Get the active version
    const versionStmt = this.db.prepare(`
      SELECT * FROM scenario_versions 
      WHERE scenario_id = ? AND is_active = true
      ORDER BY version_number DESC 
      LIMIT 1
    `);
    const versionRow = versionStmt.get(scenarioId) as ScenarioVersionRow | undefined;
    
    if (!versionRow) {
      return null;
    }

    return {
      id: scenarioRow.id,
      name: scenarioRow.name,
      config: JSON.parse(versionRow.configuration),
      history: [], // Not storing conversation history in database yet
      created: new Date(scenarioRow.created_at).getTime(),
      modified: new Date(scenarioRow.updated_at).getTime()
    };
  }

  findScenarioByIdAndVersion(scenarioId: string, versionId?: string): ScenarioConfiguration | null {
    let versionStmt;
    let params;
    
    if (versionId) {
      versionStmt = this.db.prepare(`
        SELECT * FROM scenario_versions 
        WHERE scenario_id = ? AND id = ?
      `);
      params = [scenarioId, versionId];
    } else {
      versionStmt = this.db.prepare(`
        SELECT * FROM scenario_versions 
        WHERE scenario_id = ? AND is_active = true
        ORDER BY version_number DESC 
        LIMIT 1
      `);
      params = [scenarioId];
    }
    
    const versionRow = versionStmt.get(...params) as ScenarioVersionRow | undefined;
    
    if (!versionRow) {
      return null;
    }

    return JSON.parse(versionRow.configuration);
  }

  insertScenario(scenario: ScenarioItem): void {
    const transaction = this.db.transaction(() => {
      // Insert scenario
      const scenarioStmt = this.db.prepare(`
        INSERT INTO scenarios (id, name, description, created_at, updated_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      scenarioStmt.run(
        scenario.id,
        scenario.name,
        scenario.config.scenarioMetadata.description,
        new Date(scenario.created).toISOString(),
        new Date(scenario.modified).toISOString(),
        JSON.stringify({})
      );

      // Insert initial version
      this.insertScenarioVersionInternal(scenario.id, scenario.config, true);
    });
    
    transaction();
  }

  insertScenarioVersion(scenarioId: string, configuration: ScenarioConfiguration): string {
    return this.insertScenarioVersionInternal(scenarioId, configuration, false);
  }

  private insertScenarioVersionInternal(scenarioId: string, configuration: ScenarioConfiguration, isActive: boolean): string {
    // Get next version number
    const maxVersionStmt = this.db.prepare(`
      SELECT COALESCE(MAX(version_number), 0) as max_version 
      FROM scenario_versions 
      WHERE scenario_id = ?
    `);
    const result = maxVersionStmt.get(scenarioId) as { max_version: number };
    const nextVersion = result.max_version + 1;

    // Generate version ID
    const versionId = `${scenarioId}-v${nextVersion}`;

    // If this is the new active version, deactivate others
    if (isActive) {
      const deactivateStmt = this.db.prepare(`
        UPDATE scenario_versions 
        SET is_active = false 
        WHERE scenario_id = ?
      `);
      deactivateStmt.run(scenarioId);
    }

    // Insert new version
    const insertStmt = this.db.prepare(`
      INSERT INTO scenario_versions (id, scenario_id, version_number, configuration, created_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    insertStmt.run(
      versionId,
      scenarioId,
      nextVersion,
      JSON.stringify(configuration),
      new Date().toISOString(),
      isActive
    );

    return versionId;
  }

  updateScenario(scenarioId: string, updates: Partial<ScenarioItem>): void {
    const fields = [];
    const values = [];
    
    if (updates.name) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    
    if (updates.config) {
      // Create new version when config changes
      this.insertScenarioVersionInternal(scenarioId, updates.config, true);
    }
    
    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(scenarioId);
      
      const stmt = this.db.prepare(`
        UPDATE scenarios 
        SET ${fields.join(', ')} 
        WHERE id = ?
      `);
      stmt.run(...values);
    }
  }

  deleteScenario(scenarioId: string): void {
    const transaction = this.db.transaction(() => {
      // Delete versions first (foreign key constraint)
      const deleteVersionsStmt = this.db.prepare(`
        DELETE FROM scenario_versions WHERE scenario_id = ?
      `);
      deleteVersionsStmt.run(scenarioId);
      
      // Delete scenario
      const deleteScenarioStmt = this.db.prepare(`
        DELETE FROM scenarios WHERE id = ?
      `);
      deleteScenarioStmt.run(scenarioId);
    });
    
    transaction();
  }

  listScenarios(): ScenarioItem[] {
    const stmt = this.db.prepare(`
      SELECT s.*, sv.configuration 
      FROM scenarios s
      JOIN scenario_versions sv ON s.id = sv.scenario_id AND sv.is_active = true
      ORDER BY s.updated_at DESC
    `);
    
    const rows = stmt.all() as (ScenarioRow & { configuration: string })[];
    
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      config: JSON.parse(row.configuration),
      history: [], // Not storing conversation history yet
      created: new Date(row.created_at).getTime(),
      modified: new Date(row.updated_at).getTime()
    }));
  }

  searchScenarios(search: string): ScenarioItem[] {
    const stmt = this.db.prepare(`
      SELECT s.*, sv.configuration 
      FROM scenarios s
      JOIN scenario_versions sv ON s.id = sv.scenario_id AND sv.is_active = true
      WHERE s.name LIKE ? OR s.description LIKE ?
      ORDER BY s.updated_at DESC
    `);
    
    const searchPattern = `%${search}%`;
    const rows = stmt.all(searchPattern, searchPattern) as (ScenarioRow & { configuration: string })[];
    
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      config: JSON.parse(row.configuration),
      history: [], // Not storing conversation history yet
      created: new Date(row.created_at).getTime(),
      modified: new Date(row.updated_at).getTime()
    }));
  }

  close(): void {
    this.db.close();
  }
}