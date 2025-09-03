import { describe, it, expect } from 'bun:test'
import { parseOracleResponseAligned, ScenarioPlannerV03 } from '../src/frontend/planner/planners/scenario-planner'
import type { Fact, PlanContext, PlanInput, LlmProvider } from '../src/shared/journal-types'

function wrapJson(obj: any, tag: 'json'|'plain' = 'json') {
  const body = JSON.stringify(obj, null, 2)
  return tag === 'json' ? '```json\n' + body + '\n```' : '```\n' + body + '\n```'
}

describe('Oracle parser — strict + rescue', () => {
  it('parses valid fenced JSON and returns object output', () => {
    const payload = { reasoning: 'ok', output: { documents: [{ name: 'a.json', contentType: 'application/json', contentJson: { a: 1 } }] } }
    const content = wrapJson(payload, 'json')
    const parsed = parseOracleResponseAligned(content)
    expect(typeof parsed.output).toBe('object')
    const docs = (parsed.output as any)?.documents
    expect(Array.isArray(docs)).toBe(true)
    expect(docs.length).toBe(1)
  })

  it('rescues a single missing bracket in documents array', () => {
    const broken = '```json\n' + [
      '{',
      '  "reasoning": "ok",',
      '  "output": {',
      '    "documents": [',
      '      {',
      '        "name": "b.json", "contentType": "application/json", "contentJson": {"b":2}',
      '      }',
      '    ', // ← missing closing ] here (rescuer should add it)
      '  }',
      '}',
      '```'
    ].join('\n')
    const parsed = parseOracleResponseAligned(broken)
    expect(typeof parsed.output).toBe('object')
    const docs = (parsed.output as any)?.documents
    expect(Array.isArray(docs)).toBe(true)
    expect(docs.length).toBe(1)
    expect(docs[0].name).toBe('b.json')
  })

  it('throws on irreparable JSON', () => {
    const irreparable = '```json\n{"reasoning":"x","output": { documents: [ { name: "x" } } }\n```' // missing quotes around keys and mismatched braces
    expect(() => parseOracleResponseAligned(irreparable)).toThrow()
  })
})

// Integration tests for planner ↔ oracle with rescue/strict handling
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

function makeCtx(scenario: any, oracleResponder: (prompt: string, attempt: number) => string): PlanContext<any> {
  let calls = 0
  const llm: LlmProvider = {
    async chat(req) {
      const last = req.messages[req.messages.length - 1]?.content || ''
      if (String(last).includes('<RESPONSE>')) {
        // Decision phase: choose the only scenario tool
        const tool = scenario.agents[0].tools[0].toolName
        return { text: JSON.stringify({ reasoning: 'ok', action: { tool, args: {} } }) }
      }
      calls++
      return { text: oracleResponder(String(last), calls) }
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

describe('Oracle integration — rescue + strict retries', () => {
  it('rescues missing bracket and emits attachments', async () => {
    const toolName = 'create_mixing_order'
    const scenario = makeScenarioWithTool(toolName)
    const broken = '```json\n' + [
      '{',
      '  "reasoning": "ok",',
      '  "output": {',
      '    "documents": [',
      '      { "name": "mix.json", "contentType": "application/json", "contentJson": {"order":1} }',
      '    ',
      '  }',
      '}',
      '```'
    ].join('\n')
    const ctx = makeCtx(scenario, () => broken)
    const input: PlanInput = { cut: { seq: 0 }, facts: [] }
    const out = await ScenarioPlannerV03.plan(input, ctx)
    const added = out.filter(f => f.type === 'attachment_added') as any[]
    expect(added.length).toBe(1)
    expect(added[0].name).toContain('mix')
    const tr = out.find(f => f.type === 'tool_result') as any
    expect(tr?.ok).toBe(true)
    expect(Array.isArray(tr?.result?.documents)).toBe(true)
  })

  it('retries and fails cleanly after 3 irreparable attempts', async () => {
    const toolName = 'create_mixing_order'
    const scenario = makeScenarioWithTool(toolName)
    const bad = '```json\n{"reasoning":"x","output": { documents: [ { name: "x" } } }\n```'
    const ctx = makeCtx(scenario, () => bad)
    const input: PlanInput = { cut: { seq: 0 }, facts: [] }
    const out = await ScenarioPlannerV03.plan(input, ctx)
    const tr = out.find(f => f.type === 'tool_result') as any
    const perr = out.find(f => (f as any).type === 'planner_error') as any
    expect(tr?.ok).toBe(false)
    expect(perr?.code).toBe('TOOL_EXEC_FAILED')
  })
})

