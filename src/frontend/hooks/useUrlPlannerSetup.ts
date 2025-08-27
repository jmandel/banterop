import { useEffect, useState } from 'react';
import { useAppStore } from '../state/store';
import { decodeSetup, type SetupPayload } from '../../shared/setup-hash';

export function useUrlPlannerSetup(): SetupPayload | null {
  const [urlSetup, setUrlSetup] = useState<SetupPayload | null>(null);
  const setPlanner = useAppStore(s => s.setPlanner);
  const setPlannerMode = useAppStore(s => s.setPlannerMode);

  useEffect(() => {
    function applyFromHash() {
      let setup: SetupPayload | null = null;
      try { setup = decodeSetup(window.location.hash); } catch {}
      if (!setup || !setup.planner) { setUrlSetup(null); return; }
      try {
        const pid = (setup.planner.id || 'off') as any;
        setPlanner(pid);
        if (setup.planner.mode) setPlannerMode(setup.planner.mode);
      } catch {}
      setUrlSetup(setup);
    }
    applyFromHash();
    window.addEventListener('hashchange', applyFromHash);
    return () => { window.removeEventListener('hashchange', applyFromHash); };
  }, [setPlanner, setPlannerMode]);

  return urlSetup;
}

