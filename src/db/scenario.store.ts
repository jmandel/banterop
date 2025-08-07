import type { Database } from 'bun:sqlite';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';

export interface ScenarioItem {
  id: string;
  name: string;
  config: ScenarioConfiguration;
  history: any[];
  createdAt: string;
  modifiedAt: string;
}

export class ScenarioStore {
  constructor(private db: Database) {}

  insertScenario(item: Omit<ScenarioItem, 'createdAt' | 'modifiedAt'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO scenarios (id, name, config, history)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(
      item.id,
      item.name,
      JSON.stringify(item.config),
      JSON.stringify(item.history || [])
    );
  }

  findScenarioById(id: string): ScenarioItem | null {
    const row = this.db.prepare(`
      SELECT id, name, config, history, created_at as createdAt, modified_at as modifiedAt
      FROM scenarios
      WHERE id = ?
    `).get(id) as any;
    
    if (!row) return null;
    
    return {
      id: row.id,
      name: row.name,
      config: JSON.parse(row.config),
      history: JSON.parse(row.history),
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt,
    };
  }

  listScenarios(): ScenarioItem[] {
    const rows = this.db.prepare(`
      SELECT id, name, config, history, created_at as createdAt, modified_at as modifiedAt
      FROM scenarios
      ORDER BY modified_at DESC
    `).all() as any[];
    
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      config: JSON.parse(row.config),
      history: JSON.parse(row.history),
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt,
    }));
  }

  updateScenario(id: string, updates: Partial<Pick<ScenarioItem, 'name' | 'config'>>): void {
    const sets: string[] = [];
    const values: any[] = [];
    
    if (updates.name !== undefined) {
      sets.push('name = ?');
      values.push(updates.name);
    }
    
    if (updates.config !== undefined) {
      sets.push('config = ?');
      values.push(JSON.stringify(updates.config));
    }
    
    if (sets.length === 0) return;
    
    sets.push('modified_at = datetime("now")');
    values.push(id);
    
    const stmt = this.db.prepare(`
      UPDATE scenarios
      SET ${sets.join(', ')}
      WHERE id = ?
    `);
    stmt.run(...values);
  }

  deleteScenario(id: string): void {
    const stmt = this.db.prepare('DELETE FROM scenarios WHERE id = ?');
    stmt.run(id);
  }
}