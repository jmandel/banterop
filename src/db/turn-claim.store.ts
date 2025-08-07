import type { Database } from 'bun:sqlite';

export interface TurnClaimRow {
  conversation: number;
  guidanceSeq: number;
  agentId: string;
  claimedAt: string;
  expiresAt: string;
}

export interface ClaimTurnParams {
  conversation: number;
  guidanceSeq: number;
  agentId: string;
  expiresAt: string;
}

export class TurnClaimStore {
  constructor(private db: Database) {}

  /**
   * Attempt to claim a turn. Returns true if successful, false if already claimed.
   */
  claim(params: ClaimTurnParams): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO turn_claims (conversation, guidance_seq, agent_id, expires_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(params.conversation, params.guidanceSeq, params.agentId, params.expiresAt);
      return true;
    } catch (err) {
      // SQLite UNIQUE constraint violation means already claimed
      const error = err as Error;
      if (error.message.includes('UNIQUE') || error.message.includes('PRIMARY')) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Get the current claim for a conversation/guidance pair
   */
  getClaim(conversation: number, guidanceSeq: number): TurnClaimRow | null {
    const row = this.db
      .prepare(
        `SELECT conversation, guidance_seq as guidanceSeq, agent_id as agentId,
                claimed_at as claimedAt, expires_at as expiresAt
         FROM turn_claims
         WHERE conversation = ? AND guidance_seq = ?`
      )
      .get(conversation, guidanceSeq) as TurnClaimRow | undefined;
    return row || null;
  }

  /**
   * Delete expired claims (for watchdog cleanup)
   */
  deleteExpired(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `DELETE FROM turn_claims
         WHERE expires_at < ?`
      )
      .run(now);
    return result.changes;
  }

  /**
   * Get all expired claims (for emitting expiry events)
   */
  getExpired(): TurnClaimRow[] {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT conversation, guidance_seq as guidanceSeq, agent_id as agentId,
                claimed_at as claimedAt, expires_at as expiresAt
         FROM turn_claims
         WHERE expires_at < ?`
      )
      .all(now) as TurnClaimRow[];
  }

  /**
   * Delete a specific claim (when turn is completed)
   */
  deleteClaim(conversation: number, guidanceSeq: number): void {
    this.db
      .prepare(
        `DELETE FROM turn_claims
         WHERE conversation = ? AND guidance_seq = ?`
      )
      .run(conversation, guidanceSeq);
  }

  /**
   * Get active claims for a conversation
   */
  getActiveClaimsForConversation(conversation: number): TurnClaimRow[] {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT conversation, guidance_seq as guidanceSeq, agent_id as agentId,
                claimed_at as claimedAt, expires_at as expiresAt
         FROM turn_claims
         WHERE conversation = ? AND expires_at > ?
         ORDER BY guidance_seq DESC`
      )
      .all(conversation, now) as TurnClaimRow[];
  }
}