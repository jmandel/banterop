import { describe, it, expect, beforeEach } from 'bun:test';
import Database from 'bun:sqlite';
import { ConversationStore } from './conversation.store';
import { SCHEMA_SQL } from './schema.sql';
import type { CreateConversationRequest } from '$src/types/conversation.meta';

describe('Conversation Metadata', () => {
  let db: Database;
  let store: ConversationStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    store = new ConversationStore(db);
  });

  it('stores and retrieves full metadata', () => {
    const params: CreateConversationRequest = {
      meta: {
        title: 'Test Conversation',
        description: 'Test description',
        scenarioId: 'test-scenario',
        agents: [
          {
            id: 'user-1',
            kind: 'external',
            role: 'user',
            displayName: 'Test User',
          },
          {
            id: 'assistant-1',
            kind: 'internal',
            role: 'assistant',
            config: { model: 'gpt-4' },
          },
        ],
        config: {
          idleTurnMs: 60000,
        },
        custom: {
          organizationId: 'test-org',
          tags: ['test', 'metadata'],
        },
      },
    };

    const id = store.create(params);
    const convo = store.getWithMetadata(id);

    expect(convo).toBeTruthy();
    expect(convo!.metadata.title).toBe('Test Conversation');
    expect(convo!.metadata.description).toBe('Test description');
    expect(convo!.metadata.scenarioId).toBe('test-scenario');
    expect(convo!.metadata.agents).toHaveLength(2);
    expect(convo!.metadata.agents[0]).toEqual({
      id: 'user-1',
      kind: 'external',
      role: 'user',
      displayName: 'Test User',
    });
    expect(convo!.metadata.config).toEqual({ idleTurnMs: 60000 });
    expect(convo!.metadata.custom).toEqual({
      organizationId: 'test-org',
      tags: ['test', 'metadata'],
    });
  });

  it('handles minimal metadata', () => {
    const params: CreateConversationRequest = {
      meta: {
        agents: [],
      },
    };

    const id = store.create(params);
    const convo = store.getWithMetadata(id);

    expect(convo).toBeTruthy();
    expect(convo!.metadata.agents).toEqual([]);
    expect(convo!.metadata.title).toBeUndefined();
    expect(convo!.metadata.description).toBeUndefined();
  });



  it('indexes scenario_id for queries', () => {
    // Create multiple conversations with different scenarios
    store.create({ meta: { scenarioId: 'scenario-a', agents: [] } });
    store.create({ meta: { scenarioId: 'scenario-b', agents: [] } });
    store.create({ meta: { scenarioId: 'scenario-a', agents: [] } });

    // Query by scenario (would need to add this method to store)
    const rows = db.prepare(
      `SELECT COUNT(*) as count FROM conversations WHERE json_extract(meta_json, '$.scenarioId') = ?`
    ).get('scenario-a') as { count: number };

    expect(rows.count).toBe(2);
  });

  it('stores complex agent config', () => {
    const params: CreateConversationRequest = {
      meta: {
        agents: [
          {
            id: 'complex-agent',
            kind: 'internal',
            config: {
              model: 'gpt-4',
              temperature: 0.7,
              tools: ['search', 'calculator'],
              nested: {
                deeply: {
                  nested: 'value',
                },
              },
            },
          },
        ],
      },
    };

    const id = store.create(params);
    const convo = store.getWithMetadata(id);

    expect(convo!.metadata.agents[0]?.config).toEqual({
      model: 'gpt-4',
      temperature: 0.7,
      tools: ['search', 'calculator'],
      nested: {
        deeply: {
          nested: 'value',
        },
      },
    });
  });
});