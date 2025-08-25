import type { A2APart } from '../../shared/a2a-types';
import { PlannerHarness } from './harness';
import { StoreJournal } from './store-journal';
import { SimpleDemoPlanner } from './planners/simple-demo';
import { LLMDrafterPlanner } from './planners/llm-drafter';
import { useAppStore } from '../state/store';
import type { FrameResult } from '../transports/a2a-client';

let started = false;
let currentHarness: PlannerHarness<any> | null = null;
let journalSingleton: StoreJournal | null = null;

export function startPlannerController() {
  if (started) return; // idempotent start
  started = true;

  const journal = journalSingleton || (journalSingleton = new StoreJournal());

  async function* sendMessage(parts: A2APart[], { messageId }: { messageId: string; signal?: AbortSignal }): AsyncGenerator<FrameResult> {
    const { adapter, taskId } = useAppStore.getState();
    if (!adapter) return;
    const { snapshot } = await adapter.send(parts, { taskId, messageId, finality: 'turn' });
    // Adapter returns TransportSnapshot (task-like); coerce to FrameResult
    yield (snapshot as unknown as FrameResult);
  }

  function pickPlanner(id: string): { planner: any; cfg: any } {
    if (id === 'llm') return { planner: LLMDrafterPlanner, cfg: { endpoint: undefined, model: undefined, temperature: 0.2 } };
    return { planner: SimpleDemoPlanner, cfg: { mode: 'suggest' } };
  }

  function rebuildHarness() {
    const plannerId = useAppStore.getState().plannerId || 'simple';
    const { planner, cfg } = pickPlanner(plannerId);
    if (currentHarness) { try { currentHarness.disableAutoPlan(); } catch {} }
    currentHarness = new PlannerHarness(
      journal,
      planner as any,
      sendMessage,
      cfg as any,
      { myAgentId: 'planner', otherAgentId: 'counterpart' },
      {
        onHudFlush(evs) { try { console.debug('[planner hud]', evs.map(e=>`${e.phase}:${e.label||''}`).join(' | ')); } catch {} },
        onComposerOpened(ci) { try { console.debug('[planner compose]', ci); } catch {} },
        onQuestion(q) { try { console.debug('[planner question]', q); } catch {} }
      }
    );
    currentHarness.enableAutoPlan();
  }

  rebuildHarness();
  useAppStore.subscribe((s, prev) => {
    if (s.plannerId !== prev.plannerId) rebuildHarness();
  });
}
