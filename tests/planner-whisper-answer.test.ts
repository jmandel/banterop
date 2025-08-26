import { describe, it, expect } from 'bun:test'
import { ScenarioPlannerV03 } from '../src/frontend/planner/planners/scenario-planner'
import type { PlanInput, PlanContext, LlmProvider, Fact } from '../src/shared/journal-types'

function stamp<F extends Omit<Fact, 'seq'|'ts'|'id'>>(base: F, seq: number): Fact {
  return { ...(base as any), seq, ts: '2025-01-01T00:00:00.000Z', id: `f${seq}` } as Fact
}

const dummyLLM: LlmProvider = { async chat() { return { text: '' } } }

const minimalScenario = {
  metadata: { id: 'x', title: 'X', description: 'x' },
  agents: [
    {
      agentId: 'planner',
      principal: { type: 'organization', name: 'Org', description: 'Org' },
      situation: '',
      systemPrompt: 'You are an agent representing Org.',
      goals: ['g'],
      tools: [],
      knowledgeBase: {},
      messageToUseWhenInitiatingConversation: 'Hello'
    }
  ]
}

describe('ScenarioPlanner — whisper as answer', () => {
  it('emits agent_answer when user whisper matches Answer <qid>:', async () => {
    const facts: Fact[] = [
      stamp({ type:'status_changed', a2a: 'input-required' }, 1),
      stamp({ type:'agent_question', qid:'q123', prompt:'Provide info?' }, 2),
      stamp({ type:'user_guidance', gid:'g1', text:'Answer q123: yes, proceed' }, 3),
    ]
    const input: PlanInput = { cut: { seq: 3 }, facts }
    const ctx: PlanContext<any> = {
      hud(){}, newId:(p?:string)=> (p||'id') + Math.random().toString(36).slice(2,6),
      readAttachment: async () => null,
      config: { scenario: minimalScenario },
      myAgentId: 'planner', otherAgentId: 'counterpart', model: 'test',
      llm: dummyLLM,
    }
    const out = await ScenarioPlannerV03.plan(input, ctx)
    expect(out.length).toBe(1)
    expect(out[0].type).toBe('agent_answer')
    if (out[0].type === 'agent_answer') {
      expect(out[0].qid).toBe('q123')
      expect(out[0].text).toContain('yes, proceed')
    }
  })
})

