import { useAppStore } from './appStore';
import { StorageService } from '../services/StorageService';
import { useConfigStore } from './configStore';

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number) {
  let t: any;
  return (...args: Parameters<T>) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const storage = new StorageService();

// Persist planner event log snapshots (debounced)
const persistEvents = debounce(() => {
  try {
    const state = useAppStore.getState();
    const ep = state.connection.endpoint;
    const tid = state._internal.taskClient?.getTaskId();
    if (ep && tid) {
      storage.saveTaskSession(ep, tid, {
        taskId: tid,
        status: state.task.status as any,
        plannerStarted: state.planner.started,
        plannerEvents: state.planner.eventLog as any,
      });
    }
  } catch {}
}, 500);

// Flush snapshot immediately (used on unload/visibility changes)
function persistEventsNow() {
  try {
    const state = useAppStore.getState();
    const ep = state.connection.endpoint;
    const tid = state._internal.taskClient?.getTaskId();
    if (!ep || !tid) return;
    storage.saveTaskSession(ep, tid, {
      taskId: tid,
      status: state.task.status as any,
      plannerStarted: state.planner.started,
      plannerEvents: state.planner.eventLog as any,
    });
  } catch {}
}

useAppStore.subscribe((state, prev) => {
  try {
    if (!prev || state.planner.eventLog !== prev.planner.eventLog) persistEvents();
  } catch {}
});

// Ensure we don't lose the last events on page close or backgrounding
try {
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', persistEventsNow);
    document.addEventListener('visibilitychange', () => {
      try { if (document.visibilityState === 'hidden') persistEventsNow(); } catch {}
    });
  }
} catch {}

// Initialize configuration store: URL → storage → hardcoded
(function initConfigAndBridge() {
  const cfg = useConfigStore.getState();
  cfg.actions.initializeFromUrl();
  cfg.actions.initializeFromStorage();
  cfg.actions.initializeRuntime();

  // Push initial config into app store
  const runtime = useConfigStore.getState().runtime;
  const a = useAppStore.getState().actions;
  a.setEndpoint(runtime.endpoint);
  a.setProtocol(runtime.protocol);
  if (runtime.scenarioUrl) a.setScenarioUrl(runtime.scenarioUrl);
  if (runtime.model) a.setModel(runtime.model);
  if (runtime.instructions) a.setInstructions(runtime.instructions);
  if (runtime.plannerAgentId) a.selectAgent('planner', runtime.plannerAgentId);
  if (runtime.counterpartAgentId) a.selectAgent('counterpart', runtime.counterpartAgentId);

  // Bridge config → app store (keeps connection/testing in sync with Step 1)
  useConfigStore.subscribe((state, prev) => {
    try {
      const prevRt = prev?.runtime;
      const rt = state.runtime;
      if (!prevRt || rt.endpoint !== prevRt.endpoint) useAppStore.getState().actions.setEndpoint(rt.endpoint);
      if (!prevRt || rt.protocol !== prevRt.protocol) useAppStore.getState().actions.setProtocol(rt.protocol);
      if (!prevRt || rt.scenarioUrl !== prevRt.scenarioUrl) useAppStore.getState().actions.setScenarioUrl(rt.scenarioUrl);
      if (!prevRt || rt.model !== prevRt.model) useAppStore.getState().actions.setModel(rt.model);
      if (!prevRt || rt.instructions !== prevRt.instructions) useAppStore.getState().actions.setInstructions(rt.instructions);
      if (!prevRt || rt.plannerAgentId !== prevRt.plannerAgentId) { if (rt.plannerAgentId) useAppStore.getState().actions.selectAgent('planner', rt.plannerAgentId); }
      if (!prevRt || rt.counterpartAgentId !== prevRt.counterpartAgentId) { if (rt.counterpartAgentId) useAppStore.getState().actions.selectAgent('counterpart', rt.counterpartAgentId); }
    } catch {}
  });
})();

// Keep scenario URL persisted when it changes (legacy/global key)
useAppStore.subscribe((state, prev) => {
  try {
    const prevUrl = prev?.scenario?.url;
    const nextUrl = state.scenario.url;
    if (nextUrl !== prevUrl) storage.saveScenarioUrl(nextUrl || '');
  } catch {}
});
