import type { ScenarioConfiguration } from '$lib/types.js';

export function createBlankScenario(): ScenarioConfiguration {
  return {
    metadata: {
      id: '',
      title: 'Untitled Scenario',
      description: '',
      tags: []
    },
    scenario: {
      background: '',
      challenges: []
    },
    agents: []
  };
}

export function createDefaultScenario(): ScenarioConfiguration {
  return {
    metadata: {
      id: `scen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: 'New Scenario',
      description: 'A new scenario for testing language-first interoperability',
      tags: ['new-scenario']
    },
    scenario: {
      background: 'This is the overall story or context for the interaction. What problem are the agents trying to solve together?',
      challenges: [
        'List the key obstacles or points of friction the agents will need to navigate.',
        'For example, a policy requirement, a piece of missing information, or a scheduling conflict.'
      ]
    },
    agents: [
      {
        agentId: 'agent-1',
        principal: {
          type: 'individual',
          name: 'Principal One',
          description: 'The person or entity that Agent One represents.'
        },
        situation: 'Describe the agent\'s starting context or what they know right before the conversation begins.',
        systemPrompt: 'You are Agent One. Your core instruction and persona go here.',
        goals: ['List the high-level objectives for this agent.'],
        tools: [
          {
            toolName: 'complete_action',
            description: 'A tool that represents a successful conclusion to the workflow.',
            inputSchema: { type: 'object', properties: { reason: { type: 'string' } } },
            synthesisGuidance: 'Return a confirmation message indicating success.',
            endsConversation: true,
            conversationEndStatus: 'success'
          }
        ],
        knowledgeBase: {
          private_data_field_1: 'This is private information only Agent One\'s tools can access.',
          private_data_field_2: 12345
        },
        messageToUseWhenInitiatingConversation: 'This is the opening message if I start the conversation.'
      },
      {
        agentId: 'agent-2',
        principal: {
          type: 'organization',
          name: 'Principal Two',
          description: 'The organization that Agent Two represents.'
        },
        situation: 'Describe Agent Two\'s starting context.',
        systemPrompt: 'You are Agent Two. Your core instruction and persona go here.',
        goals: ['List the high-level objectives for this agent.'],
        tools: [],
        knowledgeBase: {
          internal_policy_id: 'XYZ-789',
          business_rules: ['Rule A must be met before Rule B.']
        }
      }
    ]
  };
}