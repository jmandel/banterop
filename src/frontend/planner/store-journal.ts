import { Journal } from './harness';
import { useAppStore } from '../state/store';
import type { Fact, ProposedFact, Cut } from '../../shared/journal-types';

/**
 * StoreJournal: Journal facade backed by the Zustand store.
 * - Subclasses Journal for nominal compatibility
 * - Reads/writes use useAppStore; never touches super's private state
 */
export class StoreJournal extends Journal {
  // ---- Reads ----
  override facts(): ReadonlyArray<Fact> {
    return useAppStore.getState().facts;
    }

  override head(): Cut {
    const seq = useAppStore.getState().seq || 0;
    return { seq };
  }

  // ---- Writes (stamp in store; do not call super) ----
  override clear(): void {
    useAppStore.setState({ facts: [], seq: 0 });
  }

  override append(f: ProposedFact, vis: 'public' | 'private'): Fact {
    const stamped = this.stampBatch([f], () => vis)[0];
    this.applyStamped([stamped]);
    return stamped;
  }

  override casAppend(
    baseSeq: number,
    batch: ProposedFact[],
    visResolver: (f: ProposedFact) => 'public' | 'private'
  ): boolean {
    const current = useAppStore.getState().seq || 0;
    if (current !== baseSeq) return false;
    const stamped = this.stampBatch(batch, visResolver, baseSeq);
    this.applyStamped(stamped);
    return true;
  }

  // ---- Notifications ----
  override onAnyNewEvent(fn: () => void): () => boolean {
    let prev = useAppStore.getState().seq || 0;
    const unsub = useAppStore.subscribe((s) => {
      const seq = s.seq || 0;
      if (seq !== prev) {
        prev = seq;
        try { fn(); } catch {}
      }
    });
    return () => { try { unsub(); } catch {}; return true; };
  }

  // ---- helpers ----
  private stampBatch(
    batch: ProposedFact[],
    visResolver: (f: ProposedFact) => 'public' | 'private',
    baseSeq?: number
  ): Fact[] {
    const seq0 = (typeof baseSeq === 'number' ? baseSeq : (useAppStore.getState().seq || 0));
    const now = new Date().toISOString();
    return batch.map((f, i) => ({
      ...(f as any),
      seq: seq0 + 1 + i,
      ts: now,
      id: `f-${crypto.randomUUID()}`,
      vis: visResolver(f),
    })) as Fact[];
  }

  private applyStamped(stamped: Fact[]) {
    if (!stamped.length) return;
    useAppStore.setState((s) => ({
      facts: [...s.facts, ...stamped],
      seq: stamped[stamped.length - 1].seq,
    }));
  }
}
