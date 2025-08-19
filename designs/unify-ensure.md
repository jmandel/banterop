Excellent proposal. You've pinpointed the exact asymmetry. Let's formalize a plan to align these interfaces, creating a clean, abstract API for agent lifecycle management that works identically whether you're on the server or in the browser.

The goal is to have a single way of thinking about managing agents, backed by environment-specific implementations.

### The Plan: Create a Unified `AgentLifecycleManager`

We will create a set of interfaces to represent the distinct responsibilities of agent management, and then provide server-side and client-side implementations.

1.  **`IAgentRegistry`**: The persistent store. Remembers which agents *should* be running.
2.  **`IAgentHost`**: The runtime manager. Manages the *live, in-memory* agent instances.
3.  **`AgentLifecycleManager`**: The public API. Coordinates the registry and the host to provide a simple, unified interface (`ensure`, `stop`, `resume`).

Here is a step-by-step plan to implement this.

---

### Step 1: Define the Unified Interfaces

First, we'll create new interface files to define the contract for our components.

**File: `src/control/agent-lifecycle.interfaces.ts`**

```typescript
import type { AgentHandle, AgentRuntimeInfo, StartAgentsOptions } from '$src/agents/factories/agent.factory';

/**
 * Manages the persistent record of which agents should be running.
 */
export interface IAgentRegistry {
  register(conversationId: number, agentIds: string[]): Promise<void>;
  unregister(conversationId: number, agentIds?: string[]): Promise<void>;
  listRegistered(): Promise<Map<number, string[]>>; // Map<conversationId, agentId[]>
}

/**
 * Manages the live, in-memory instances of running agents.
 */
export interface IAgentHost {
  ensure(conversationId: number, agentIds: string[]): Promise<void>;
  stop(conversationId: number): Promise<void>;
  list(conversationId: number): AgentRuntimeInfo[];
  stopAll(): Promise<void>;
}

/**
 * The unified public API for managing agent lifecycles.
 * Coordinates between a registry (persistence) and a host (runtime).
 */
export interface IAgentLifecycleManager {
  ensure(conversationId: number, agentIds: string[]): Promise<{ ensured: AgentRuntimeInfo[] }>;
  stop(conversationId: number, agentIds?: string[]): Promise<void>;
  resumeAll(): Promise<void>;
}
```

---

### Step 2: Implement the Server-Side Components

We'll refactor the existing `RunnerRegistry` and `AgentHost` to fit these new interfaces and create a new `ServerAgentLifecycleManager` to coordinate them.

**1. Create `ServerAgentRegistry`**
This class will encapsulate the SQLite logic, taking responsibility from the old `RunnerRegistry`.

**File: `src/server/control/server-agent-registry.ts`**
```typescript
import type { Database } from 'bun:sqlite';
import type { IAgentRegistry } from '$src/control/agent-lifecycle.interfaces';

export class ServerAgentRegistry implements IAgentRegistry {
  constructor(private db: Database) {}

  async register(conversationId: number, agentIds: string[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO runner_registry (conversation_id, agent_id) VALUES (?, ?)`
    );
    this.db.transaction(() => {
      for (const id of agentIds) stmt.run(conversationId, id);
    })();
  }

  async unregister(conversationId: number, agentIds?: string[]): Promise<void> {
    if (agentIds?.length) {
      const stmt = this.db.prepare(
        `DELETE FROM runner_registry WHERE conversation_id = ? AND agent_id = ?`
      );
      this.db.transaction(() => {
        for (const id of agentIds) stmt.run(conversationId, id);
      })();
    } else {
      this.db.prepare(`DELETE FROM runner_registry WHERE conversation_id = ?`).run(conversationId);
    }
  }

  async listRegistered(): Promise<Map<number, string[]>> {
    const rows = this.db
      .prepare(`SELECT conversation_id, agent_id FROM runner_registry`)
      .all() as { conversation_id: number; agent_id: string }[];
      
    const byConv = new Map<number, string[]>();
    for (const row of rows) {
      if (!byConv.has(row.conversation_id)) byConv.set(row.conversation_id, []);
      byConv.get(row.conversation_id)!.push(row.agent_id);
    }
    return byConv;
  }
}
```

**2. Adapt `ServerAgentHost`**
The existing `AgentHost` (`src/server/agent-host.ts`) already perfectly matches the `IAgentHost` interface. We just need to formally declare it.

**File: `src/server/agent-host.ts` (Modify)**
```typescript
import type { IAgentHost } from '$src/control/agent-lifecycle.interfaces';
// ... other imports

export class AgentHost implements IAgentHost {
  // ... existing implementation ...
}
```

**3. Create `ServerAgentLifecycleManager`**
This new class will be the primary entry point on the server.

**File: `src/server/control/server-agent-lifecycle.ts`**
```typescript
import type { IAgentLifecycleManager, IAgentRegistry, IAgentHost } from '$src/control/agent-lifecycle.interfaces';

export class ServerAgentLifecycleManager implements IAgentLifecycleManager {
  constructor(private registry: IAgentRegistry, private host: IAgentHost) {}

  async ensure(conversationId: number, agentIds: string[]) {
    await this.registry.register(conversationId, agentIds);
    await this.host.ensure(conversationId, agentIds);
    return { ensured: this.host.list(conversationId) };
  }

  async stop(conversationId: number, agentIds?: string[]) {
    await this.registry.unregister(conversationId, agentIds);
    await this.host.stop(conversationId); // host.stop already stops all agents for a convo
  }

  async resumeAll(): Promise<void> {
    const allRegistered = await this.registry.listRegistered();
    for (const [conversationId, agentIds] of allRegistered.entries()) {
      await this.host.ensure(conversationId, agentIds);
    }
  }
}
```

---

### Step 3: Implement the Client-Side (Browser) Components

Now, we'll create the browser-side equivalents using `localStorage` and in-memory maps.

**1. Create `BrowserAgentRegistry`**
This implements the registry interface using `localStorage`.

**File: `src/agents/clients/browser-agent-registry.ts`**
```typescript
import type { IAgentRegistry } from '$src/control/agent-lifecycle.interfaces';

export class BrowserAgentRegistry implements IAgentRegistry {
  constructor(private storageKey = '__agent_registry__') {}

  private read(): Map<number, string[]> {
    const stored = localStorage.getItem(this.storageKey);
    return stored ? new Map(JSON.parse(stored)) : new Map();
  }

  private write(registry: Map<number, string[]>): void {
    localStorage.setItem(this.storageKey, JSON.stringify(Array.from(registry.entries())));
  }

  async register(conversationId: number, agentIds: string[]): Promise<void> {
    const registry = this.read();
    const existing = registry.get(conversationId) || [];
    const updated = Array.from(new Set([...existing, ...agentIds]));
    registry.set(conversationId, updated);
    this.write(registry);
  }

  async unregister(conversationId: number, agentIds?: string[]): Promise<void> {
    const registry = this.read();
    if (!agentIds?.length) {
      registry.delete(conversationId);
    } else {
      const existing = registry.get(conversationId) || [];
      const updated = existing.filter(id => !agentIds.includes(id));
      if (updated.length > 0) {
        registry.set(conversationId, updated);
      } else {
        registry.delete(conversationId);
      }
    }
    this.write(registry);
  }

  async listRegistered(): Promise<Map<number, string[]>> {
    return this.read();
  }
}
```

**2. Create `BrowserAgentHost`**
This implements the host interface, managing live agents in the browser. It will formalize the logic currently in the React UI.

**File: `src/agents/clients/browser-agent-host.ts`**
```typescript
import type { IAgentHost } from '$src/control/agent-lifecycle.interfaces';
import { startAgents, type AgentHandle, type AgentRuntimeInfo } from '$src/agents/factories/agent.factory';
import { WsTransport } from '$src/agents/runtime/ws.transport';
import { LLMProviderManager } from '$src/llm/provider-manager';

export class BrowserAgentHost implements IAgentHost {
  private byConversation = new Map<number, AgentHandle>();
  private providerManager: LLMProviderManager;

  constructor(private wsUrl: string) {
    const serverUrl = wsUrl.replace(/^ws/, 'http').replace('/api/ws', '');
    this.providerManager = new LLMProviderManager({
      defaultLlmProvider: 'browserside',
      serverUrl
    });
  }

  async ensure(conversationId: number, agentIds: string[]): Promise<void> {
    if (this.byConversation.has(conversationId)) return;
    
    const handle = await startAgents({
      conversationId,
      transport: new WsTransport(this.wsUrl),
      providerManager: this.providerManager,
      agentIds,
      turnRecoveryMode: 'restart',
    });
    this.byConversation.set(conversationId, handle);
  }

  async stop(conversationId: number): Promise<void> {
    const handle = this.byConversation.get(conversationId);
    if (handle) {
      await handle.stop();
      this.byConversation.delete(conversationId);
    }
  }

  list(conversationId: number): AgentRuntimeInfo[] {
    return this.byConversation.get(conversationId)?.agentsInfo || [];
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      Array.from(this.byConversation.keys()).map(id => this.stop(id))
    );
  }
}
```

**3. Create `BrowserAgentLifecycleManager`**
The coordinator for the browser environment.

**File: `src/agents/clients/browser-agent-lifecycle.ts`**
```typescript
import type { IAgentLifecycleManager, IAgentRegistry, IAgentHost } from '$src/control/agent-lifecycle.interfaces';

export class BrowserAgentLifecycleManager implements IAgentLifecycleManager {
  constructor(private registry: IAgentRegistry, private host: IAgentHost) {}

  async ensure(conversationId: number, agentIds: string[]) {
    await this.registry.register(conversationId, agentIds);
    await this.host.ensure(conversationId, agentIds);
    return { ensured: this.host.list(conversationId) };
  }

  async stop(conversationId: number, agentIds?: string[]) {
    await this.registry.unregister(conversationId, agentIds);
    await this.host.stop(conversationId);
  }

  async resumeAll(): Promise<void> {
    const allRegistered = await this.registry.listRegistered();
    for (const [conversationId, agentIds] of allRegistered.entries()) {
      await this.host.ensure(conversationId, agentIds);
    }
  }
}
```

---

### Step 4: Refactor Existing Code

Now, we integrate these new, aligned abstractions.

-   **Server:**
    1.  In `src/server/app.ts`, instantiate the `ServerAgentLifecycleManager` and call `manager.resumeAll()` on startup.
    2.  In `src/server/ws/jsonrpc.server.ts`, the `ensureAgentsRunningOnServer` RPC method will now call `manager.ensure()`. The old `RunnerRegistry` class can be removed.

-   **Browser:**
    1.  In `src/frontend/scenario-launcher/app.tsx`, create a single instance of the `BrowserAgentLifecycleManager` at the top level of the app.
    2.  Call `manager.resumeAll()` in a `useEffect` hook that runs once on mount.
    3.  The UI's "Start Agents (Browser)" button will now call `manager.ensure(conversationId, agentIds)`.
    4.  The logic in `ensure-client.ts` is now superseded by our new browser components and can be removed.

### Result: A Beautifully Aligned API

After this refactoring, your code to start agents, regardless of where it runs, will look like this:

```typescript
// --- In a server-side script ---
const serverManager = new ServerAgentLifecycleManager(
  new ServerAgentRegistry(db),
  new ServerAgentHost(orchestrator, providerManager)
);
await serverManager.ensure(123, ['agent-a', 'agent-b']);

// --- In a browser component ---
const browserManager = new BrowserAgentLifecycleManager(
  new BrowserAgentRegistry(),
  new BrowserAgentHost('ws://localhost:3000/api/ws')
);
await browserManager.ensure(123, ['agent-a', 'agent-b']);
```

The call to `.ensure()` is identical. You have successfully aligned the API surface by abstracting the environment-specific implementation details.
d
