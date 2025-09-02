import { describe, it, expect } from 'bun:test'
import { ScenarioPlannerV03 } from '../src/frontend/planner/planners/scenario-planner'
import type { Fact, PlanContext, PlanInput, LlmProvider } from '../src/shared/journal-types'

function stamp<F extends Omit<Fact, 'seq'|'ts'|'id'>>(base: F, seq: number): Fact {
  return { ...(base as any), seq, ts: '2025-01-01T00:00:00.000Z', id: `f${seq}` } as Fact
}

function makeScenarioWithTool(toolName: string) {
  return {
    metadata: { id: 's1', title: 'Test', description: 'Test' },
    agents: [
      {
        agentId: 'planner',
        principal: { type: 'organization', name: 'Org', description: 'Org' },
        situation: '',
        systemPrompt: 'You are an agent.',
        goals: ['g'],
        tools: [
          { toolName, description: 'test tool', inputSchema: { type: 'object', properties: {} } }
        ],
        knowledgeBase: {},
        messageToUseWhenInitiatingConversation: 'Hello'
      }
    ]
  }
}

function makeCtx(scenario: any, oracleResponder: (prompt: string) => string): PlanContext<any> {
  const llm: LlmProvider = {
    async chat(req) {
      const last = req.messages[req.messages.length - 1]?.content || ''
      if (String(last).includes('<RESPONSE>')) {
        // Decision phase: choose the only scenario tool
        const tool = scenario.agents[0].tools[0].toolName
        return { text: JSON.stringify({ reasoning: 'ok', action: { tool, args: {} } }) }
      }
      // Oracle phase
      return { text: oracleResponder(String(last)) }
    }
  }
  return {
    hud(){},
    newId:(p?:string)=> (p||'id') + Math.random().toString(36).slice(2,7),
    readAttachment: async () => null,
    config: { scenario, maxInlineSteps: 1 },
    model: 'test',
    llm,
  }
}

describe('ScenarioPlanner synthesis — multi-doc and JSON object content', () => {
  it('attaches two docs: one text, one JSON object', async () => {
    const toolName = 'publish_intake_requirements'
    const scenario = makeScenarioWithTool(toolName)
    const ctx = makeCtx(scenario, () => {
      const payload = {
        reasoning: 'two docs',
        output: {
          documents: [
            { docId: 'c1', name: 'contract.json', contentType: 'application/json', contentJson: { id: 'urn:contract:Example.v1' } },
            { docId: 'i1', name: 'interfaces.txt', contentType: 'text/plain', contentString: 'interface X { }' },
          ]
        }
      }
      return '```json\n' + JSON.stringify(payload) + '\n```'
    })
    const input: PlanInput = { cut: { seq: 0 }, facts: [] }
    const out = await ScenarioPlannerV03.plan(input, ctx)
    const added = out.filter(f => f.type === 'attachment_added') as any[]
    const names = added.map(a => a.name).sort()
    expect(names).toEqual(['contract.json', 'interfaces.txt'].sort())
    // Ensure tool_result carries documents array with updated names
    const tr = out.find(f => f.type === 'tool_result') as any
    expect(Array.isArray(tr?.result?.documents)).toBe(true)
    const resultNames = (tr?.result?.documents || []).map((d:any)=>d.name)
    expect(resultNames.sort()).toEqual(['contract.json', 'interfaces.txt'].sort())
  })

  it('uniquifies against pre-existing name', async () => {
    const toolName = 'publish_intake_requirements'
    const scenario = makeScenarioWithTool(toolName)
    const ctx = makeCtx(scenario, () => {
      const payload = {
        reasoning: 'one doc colliding',
        output: { documents: [ { name: 'contract.json', contentType: 'application/json', contentJson: { a: 1 } } ] }
      }
      return '```json\n' + JSON.stringify(payload) + '\n```'
    })
    const facts: Fact[] = [
      stamp({ type:'attachment_added', name:'contract.json', mimeType:'application/json', bytes:'e30=', origin:'synthesized' }, 1)
    ]
    const input: PlanInput = { cut: { seq: 1 }, facts }
    const out = await ScenarioPlannerV03.plan(input, ctx)
    const added = out.filter(f => f.type === 'attachment_added') as any[]
    expect(added.length).toBe(1)
    expect(added[0].name).toBe('contract (2).json')
    const tr = out.find(f => f.type === 'tool_result') as any
    expect((tr?.result?.documents?.[0]?.name)).toBe('contract (2).json')
  })

  it('fallback: attaches entire JSON output with short hash suffix', async () => {
    const toolName = 'synth'
    const scenario = makeScenarioWithTool(toolName)
    const ctx = makeCtx(scenario, () => {
      const payload = { reasoning: 'no docs', output: { foo: 'bar', arr: [1,2,3] } }
      return '```json\n' + JSON.stringify(payload) + '\n```'
    })
    const input: PlanInput = { cut: { seq: 0 }, facts: [] }
    const out = await ScenarioPlannerV03.plan(input, ctx)
    const added = out.filter(f => f.type === 'attachment_added') as any[]
    expect(added.length).toBe(1)
    const n = added[0].name as string
    expect(n.endsWith('.json')).toBe(true)
    expect(/-[A-Za-z0-9]{6}\.json$/.test(n)).toBe(true)
  })
})
