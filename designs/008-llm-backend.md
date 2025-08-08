Of course. The `v2` files provide an excellent, robust pattern for a multi-provider LLM factory. Integrating a similar system into our project is a critical step for enabling intelligent agents.

Here is a complete, self-contained development plan to build and integrate this LLM provider system.

---

### **Development Plan: Pluggable LLM Provider System**

#### **1. Project Goal & Core Architecture**

The objective is to create a centralized, pluggable system for interacting with various Large Language Models (LLMs). This allows our agents and other services to request text completion from an LLM without being hardcoded to a specific provider like Google or OpenRouter.

The architecture will consist of three main parts:

1.  **`LLMProvider` Interface:** A standard contract that all specific provider implementations (like `GoogleLLMProvider`) must adhere to.
2.  **Provider Implementations:** Concrete classes for each service (e.g., Google, OpenRouter) that handle the specific API calls and data transformations for that service.
3.  **`ProviderManager` (Factory & Registry):** A central service that reads configuration, knows about all available providers, and can create (or "vend") a configured provider instance on request.

This approach decouples the agent logic from the specifics of any single LLM API, making our system flexible and future-proof.

---

#### **2. Phase 1: Establish the Foundation (Types & Configuration)**

First, we'll define the data structures and update our central configuration management.

**Action 1: Enhance the LLM Type Definitions.**
We will adopt the richer type definitions from the `v2` project to define our provider contracts.

Modify `src/types/llm.types.ts`:
```ts
// Base request/response types (likely already exist, but ensure they're robust)
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  // ... other fields like usage, tool_calls if needed later
}

// NEW: Provider-specific types
export type SupportedProvider = 'google' | 'openrouter'; // Add more as they are implemented

export interface LLMProviderConfig {
  provider: SupportedProvider;
  apiKey?: string;
  model?: string;
}

export interface LLMProviderMetadata {
  name: SupportedProvider;
  description: string;
  models: string[];
  defaultModel: string;
}

export abstract class LLMProvider {
  constructor(protected config: LLMProviderConfig) {}
  abstract getMetadata(): LLMProviderMetadata;
  abstract complete(request: LLMRequest): Promise<LLMResponse>;
}
```

**Action 2: Update the Central Configuration Manager.**
Our application needs to be aware of the API keys for the LLM services.

Modify `src/server/config.ts`:
```ts
// In the ConfigSchema definition
const ConfigSchema = z.object({
  // ... existing config ...

  // NEW: LLM Provider Keys
  googleApiKey: z.string().optional(),
  openRouterApiKey: z.string().optional(),
  defaultLlmProvider: z.enum(['google', 'openrouter']).default('openrouter'),
});

// In the ConfigManager constructor, load from environment variables
const raw = {
  // ... existing ...
  googleApiKey: process.env.GOOGLE_API_KEY,
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  defaultLlmProvider: process.env.DEFAULT_LLM_PROVIDER,
  // ...
};
```

**Action 3: Install Dependencies.**
```bash
bun add @google/genai openai
```

---

#### **3. Phase 2: Implement the Provider Factory and Concrete Providers**

We'll now create the core logic for the LLM system by adapting the `v2` files.

**Action 1: Create the directory structure.**
Create a new directory `src/llm/` and a subdirectory `src/llm/providers/`.

**Action 2: Copy and Adapt the Provider Implementations.**
*   Copy `../v2/src/llm/providers/google.ts` to `src/llm/providers/google.ts`.
*   Copy `../v2/src/llm/providers/openrouter.ts` to `src/llm/providers/openrouter.ts`.
*   **Adaptation:** Update the imports in both files to match our project structure (e.g., `import type { ... } from '$src/types/llm.types';`). The core API call logic can remain as is.

**Action 3: Create the `ProviderManager` Service.**
This manager acts as our factory and registry. It will be the single point of entry for the rest of the application to get an LLM provider.

File: `src/llm/provider-manager.ts` (New file)
```ts
import type { Config } from '$src/server/config';
import type { LLMProvider, LLMProviderConfig, SupportedProvider } from '$src/types/llm.types';
import { GoogleLLMProvider } from './providers/google';
import { OpenRouterLLMProvider } from './providers/openrouter';

const PROVIDER_MAP = {
  google: GoogleLLMProvider,
  openrouter: OpenRouterLLMProvider,
};

export class ProviderManager {
  constructor(private appConfig: Config) {}

  /**
   * Creates an LLM provider instance based on the requested configuration.
   * If a provider is not specified, it uses the default from the app config.
   */
  getProvider(config?: Partial<LLMProviderConfig>): LLMProvider {
    const providerName = config?.provider ?? this.appConfig.defaultLlmProvider;
    const model = config?.model;

    const ProviderClass = PROVIDER_MAP[providerName];
    if (!ProviderClass) {
      throw new Error(`Unsupported LLM provider: ${providerName}`);
    }

    // Pass the correct API key from the app's central config
    let apiKey: string | undefined;
    if (providerName === 'google') {
      apiKey = config?.apiKey ?? this.appConfig.googleApiKey;
    } else if (providerName === 'openrouter') {
      apiKey = config?.apiKey ?? this.appConfig.openRouterApiKey;
    }

    if (!apiKey) {
      throw new Error(`API key for provider '${providerName}' not found in configuration or environment variables.`);
    }

    return new ProviderClass({ provider: providerName, apiKey, model });
  }

  /**
   * Returns metadata for all configured providers.
   */
  getAvailableProviders() {
    return Object.values(PROVIDER_MAP).map(p => p.getMetadata());
  }
}
```

---

#### **4. Phase 3: Integrate the `ProviderManager` into the Application**

The `ProviderManager` needs to be instantiated once and made available to services that need it.

**Action: Add the `ProviderManager` to the main `App` class.**

Modify `src/server/app.ts`:
```ts
// ... imports
import { ProviderManager } from '$src/llm/provider-manager';

export class App {
  // ... existing properties
  readonly providerManager: ProviderManager;

  constructor(configOverrides?: Partial<Config>) {
    this.config = new ConfigManager(configOverrides);
    this.storage = new Storage(this.config.dbPath);
    // NEW: Instantiate the manager with the app's config
    this.providerManager = new ProviderManager(this.config.get());
    this.orchestrator = new OrchestratorService(
      this.storage,
      // ...
    );
  }
  // ...
}
```

---

#### **5. Phase 4: Create an LLM-Powered Agent**

To validate the system, we need a consumer. We'll create a simple agent that uses the `ProviderManager` to get an LLM and generate a response.

**Action: Create `AssistantAgent`.**

File: `src/agents/assistant.agent.ts` (New file)
```ts
import type { Agent, AgentContext } from './agent.types';
import type { LLMProvider } from '$src/types/llm.types';

export class AssistantAgent implements Agent {
  constructor(private llmProvider: LLMProvider) {}

  async handleTurn(ctx: AgentContext): Promise<void> {
    ctx.logger.info(`AssistantAgent turn started. Using provider: ${this.llmProvider.getMetadata().name}`);

    // 1. Get conversation history from the snapshot
    const snapshot = await ctx.client.getSnapshot(ctx.conversationId);
    const messages = snapshot.events
      .filter(e => e.type === 'message')
      .map(e => ({
        role: e.agentId === ctx.agentId ? 'assistant' : 'user',
        content: (e.payload as any).text,
      }));

    // Add a simple system prompt
    messages.unshift({ role: 'system', content: 'You are a helpful assistant.' });

    // 2. Call the LLM provider
    const response = await this.llmProvider.complete({ messages });

    // 3. Post the response back to the conversation
    await ctx.client.postMessage({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      text: response.content,
      finality: 'turn',
    });

    ctx.logger.info('AssistantAgent turn completed.');
  }
}
```

---

#### **6. Phase 5: End-to-End Validation**

Finally, create a CLI script to run a simulation that uses the new agent and LLM system.

**Action: Create `src/cli/run-sim-llm-agent.ts`**
*This script will require environment variables for API keys to be set (e.g., in a `.env` file).*

```ts
#!/usr/bin/env bun
import { App } from '$src/server/app';
import { InternalTurnLoop } from '$src/agents/executors/internal-turn-loop';
import { AssistantAgent } from '$src/agents/assistant.agent';

// To run this:
// 1. Create a .env file:
//    OPENROUTER_API_KEY="sk-or-..."
// 2. Run with bun: `bun run src/cli/run-sim-llm-agent.ts`

async function main() {
  console.log("Starting LLM Agent Simulation...");

  // 1. Initialize the application. This will create the ProviderManager
  //    and load API keys from the environment.
  const app = new App({ dbPath: ':memory:' });

  // 2. Get a default LLM provider from the manager
  //    This will use the `defaultLlmProvider` from the config.
  const llmProvider = app.providerManager.getProvider();
  console.log(`✅ Using default provider: ${llmProvider.getMetadata().name}`);

  // 3. Create an instance of our new LLM-powered agent
  const assistantAgent = new AssistantAgent(llmProvider);

  // 4. Create a conversation and an internal executor to run the agent
  const conversationId = app.orchestrator.createConversation({ title: 'LLM Agent Test' });
  const executor = new InternalTurnLoop(assistantAgent, app.orchestrator, {
    conversationId,
    agentId: 'assistant',
  });

  // Start the agent loop in the background
  const agentPromise = executor.start();

  // 5. Kick off the conversation with a user message
  console.log("\n--- SIMULATION START ---");
  await new Promise(res => setTimeout(res, 500)); // wait for agent to be ready

  app.orchestrator.sendMessage(
    conversationId,
    'user',
    { text: "Hello! Can you explain the concept of a black hole in simple terms?" },
    'turn'
  );

  // Wait for the agent to respond
  await new Promise(res => setTimeout(res, 10000)); // Allow time for API call

  // 6. Print the final conversation state
  const finalState = app.orchestrator.getConversationSnapshot(conversationId);
  console.log("\n--- SIMULATION END ---");
  finalState.events
    .filter(e => e.type === 'message')
    .forEach(e => {
      console.log(`[${e.agentId}]: ${(e.payload as any).text}`);
    });

  // Cleanup
  executor.stop();
  await agentPromise;
  await app.shutdown();
}

main().catch(e => {
  console.error("Simulation failed:", e.message);
  process.exit(1);
});
```
