import { describe, it, expect } from 'bun:test'
import { validateScenarioConfig } from '../src/shared/scenario-validator'

const validScenario = {
  metadata: { id: 'demo_case', title: 'Demo Case', description: 'A simple scenario' },
  agents: [
    {
      agentId: 'agentA',
      principal: { type: 'individual', name: 'Dr. A', description: 'Physician' },
      situation: 'Context',
      systemPrompt: 'You are an agent representing Dr. A.',
      goals: ['Help patient'],
      tools: [
        {
          toolName: 'lookup',
          description: 'Lookup data',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          synthesisGuidance: 'Return structured info',
        },
      ],
      knowledgeBase: {},
      messageToUseWhenInitiatingConversation: 'Hello, I represent Dr. A.'
    },
  ],
}

describe('scenario-validator', () => {
  it('accepts a valid scenario', () => {
    const v = validateScenarioConfig(validScenario)
    expect(v.ok).toBeTrue()
    if (v.ok) {
      expect(v.value.metadata.id).toBe('demo_case')
      expect(v.value.agents.length).toBe(1)
    }
  })

  it('rejects missing required fields', () => {
    const bad = { metadata: { id: '', title: '', description: '' }, agents: [] }
    const v = validateScenarioConfig(bad)
    expect(v.ok).toBeFalse()
    if (!v.ok) {
      expect(Array.isArray(v.errors)).toBeTrue()
      expect(v.errors.length).toBeGreaterThan(0)
    }
  })

  it('caps errors at 10', () => {
    const tooMany = {
      metadata: {},
      agents: [
        {
          // missing many fields on purpose
          tools: Array.from({ length: 20 }, () => ({ inputSchema: { type: 'array' } })),
        },
      ],
    }
    const v = validateScenarioConfig(tooMany as any)
    expect(v.ok).toBeFalse()
    if (!v.ok) {
      expect(v.errors.length).toBeLessThanOrEqual(10)
    }
  })
})

