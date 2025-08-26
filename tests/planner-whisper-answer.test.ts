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

describe('ScenarioPlanner — user_answer answers agent_question', () => {
  it('does not gate on open question when matching user_answer exists', async () => {
    const facts: Fact[] = [
      stamp({ type:'agent_question', qid:'q123', prompt:'Provide info?' }, 1),
      stamp({ type:'user_answer', qid:'q123', text:'yes, proceed' }, 2),
    ]
    const input: PlanInput = { cut: { seq: 2 }, facts }
    const ctx: PlanContext<any> = {
      hud(){}, newId:(p?:string)=> (p||'id') + Math.random().toString(36).slice(2,6),
      readAttachment: async () => null,
      config: { scenario: minimalScenario },
      model: 'test',
      llm: dummyLLM,
    }
    const out = await ScenarioPlannerV03.plan(input, ctx)
    // Must not return the gating sleep that waits for user's answer
    const waiting = out.find(o => o.type === 'sleep' && typeof (o as any).reason === 'string' && (o as any).reason.includes("Waiting on user's answer"))
    expect(waiting).toBeUndefined()
  })
})
