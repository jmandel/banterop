import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { OrchestratorService } from "./orchestrator";
import { Storage } from "./storage";
import type { ScenarioConfiguration } from "$src/types/scenario-configuration.types";

describe("OrchestratorService config validation", () => {
  let storage: Storage;
  let orch: OrchestratorService;
  let scenario: ScenarioConfiguration;

  beforeEach(() => {
    storage = new Storage(":memory:");
    orch = new OrchestratorService(storage);

    // Minimal scenario
    scenario = {
      metadata: {
        id: "demo-scn",
        title: "Demo",
        description: "Testing",
      },
      agents: [
        {
          agentId: "agent-1",
          principal: { type: "individual", name: "A", description: "Desc" },
          situation: "",
          systemPrompt: "",
          goals: [],
          tools: [],
          knowledgeBase: {},
          messageToUseWhenInitiatingConversation: "Hello from agent-1",
        },
        {
          agentId: "agent-2",
          principal: { type: "individual", name: "B", description: "Desc" },
          situation: "",
          systemPrompt: "",
          goals: [],
          tools: [],
          knowledgeBase: {},
          messageToUseWhenInitiatingConversation: "Hello from agent-2",
        },
      ],
    };

    storage.scenarios.insertScenario({
      id: scenario.metadata.id,
      name: scenario.metadata.title,
      config: scenario,
      history: [],
    });
  });

  afterEach(async () => {
    await orch.shutdown();
    storage.close();
  });

  it("throws if runtime agent IDs don't match scenario agents 1:1", () => {
    expect(() =>
      orch.createConversation({
        meta: {
          scenarioId: "demo-scn",
          agents: [{ id: "agent-1",  }], // missing agent-2
        },
      })
    ).toThrow(/runtime agents must match scenario agents exactly/);
  });

  it("allows exact match of runtime and scenario agents", () => {
    const id = orch.createConversation({
      meta: {
        scenarioId: "demo-scn",
        agents: [
          { id: "agent-1",  },
          { id: "agent-2",  },
        ],
      },
    });
    expect(id).toBeGreaterThan(0);
  });

  it("throws when runtime has extra agents not in scenario", () => {
    expect(() =>
      orch.createConversation({
        meta: {
          scenarioId: "demo-scn",
          agents: [
            { id: "agent-1",  },
            { id: "agent-2",  },
            { id: "agent-3",  }, // extra agent
          ],
        },
      })
    ).toThrow(/runtime agents must match scenario agents exactly/);
  });

  it("throws with runtime agents in different order but still mismatched", () => {
    expect(() =>
      orch.createConversation({
        meta: {
          scenarioId: "demo-scn",
          agents: [
            { id: "agent-2",  },
            { id: "agent-3",  }, // wrong agent
          ],
        },
      })
    ).toThrow(/runtime agents must match scenario agents exactly/);
  });

  it("allows creation without scenario", () => {
    const id = orch.createConversation({
      meta: {
        agents: [
          { id: "any-agent",  },
        ],
      },
    });
    expect(id).toBeGreaterThan(0);
  });
});
