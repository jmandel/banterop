import { useAppStore } from './appStore';
import { StorageService } from '../services/StorageService';
import { extractLaunchParams, clearUrlParams } from '../utils/urlParams';

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

useAppStore.subscribe((state, prev) => {
  try {
    if (!prev || state.planner.eventLog !== prev.planner.eventLog) persistEvents();
  } catch {}
});

// One-time URL param initialization (consume and clear)
(function initFromUrlOnce() {
  try {
    const params = extractLaunchParams();
    // Clear immediately so reloads don't override working state
    clearUrlParams();
    // Save as ephemeral, one-time launch defaults. Components will use them
    // as initial values; user changes then take precedence and persist.
    useAppStore.setState((s) => { (s as any).defaultsFromUrlParameters = params; });
  } catch {
    // ignore
  }
})();
