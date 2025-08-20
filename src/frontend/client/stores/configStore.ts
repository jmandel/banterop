import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Protocol } from '../protocols';
import { extractLaunchParams, type LaunchParams, clearUrlParams } from '../utils/urlParams';

export interface AppConfig {
  endpoint: string;
  protocol: Protocol;
  scenarioUrl: string;
  plannerAgentId: string;
  counterpartAgentId: string;
  model: string;
  instructions: string;
  resumeTaskId?: string;
}

type PartialConfig = Partial<AppConfig>;

const STORAGE_KEY = 'app.config.v2';

function saveToStorage(config: AppConfig) {
  try {
    const toSave: any = { ...config };
    delete toSave.resumeTaskId; // one-time values not persisted
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch {}
}

function loadFromStorage(): PartialConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? (obj as PartialConfig) : null;
  } catch { return null; }
}

function mapLaunchToConfig(lp: LaunchParams): PartialConfig {
  const cfg: PartialConfig = {};
  if (lp.endpoint) cfg.endpoint = lp.endpoint;
  if (lp.protocol) cfg.protocol = lp.protocol as Protocol;
  if (lp.scenarioUrl) cfg.scenarioUrl = lp.scenarioUrl;
  if (lp.plannerAgentId) cfg.plannerAgentId = lp.plannerAgentId;
  if (lp.counterpartAgentId) cfg.counterpartAgentId = lp.counterpartAgentId;
  if (lp.defaultModel) cfg.model = lp.defaultModel;
  if (lp.instructions) cfg.instructions = lp.instructions;
  if (lp.resumeTaskId) cfg.resumeTaskId = lp.resumeTaskId;
  return cfg;
}

export interface ConfigStore {
  defaults: {
    fromUrl: PartialConfig | null;
    fromStorage: PartialConfig | null;
    hardcoded: AppConfig;
  };
  runtime: AppConfig;
  actions: {
    initializeFromUrl: () => void;
    initializeFromStorage: () => void;
    initializeRuntime: () => void;
    updateField: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void;
    getEffectiveValue: <K extends keyof AppConfig>(key: K) => AppConfig[K];
  };
}

const DEFAULTS: AppConfig = {
  endpoint: '',
  protocol: 'auto',
  scenarioUrl: '',
  plannerAgentId: '',
  counterpartAgentId: '',
  model: '',
  instructions: '',
};

export const useConfigStore = create<ConfigStore>()(
  immer((set, get) => ({
    defaults: {
      fromUrl: null,
      fromStorage: null,
      hardcoded: { ...DEFAULTS },
    },
    runtime: { ...DEFAULTS },
    actions: {
      initializeFromUrl: () => {
        try {
          const urlParams = extractLaunchParams();
          clearUrlParams();
          const cfg = mapLaunchToConfig(urlParams);
          if (Object.keys(cfg).length) {
            set((s) => { s.defaults.fromUrl = cfg; });
          }
        } catch {}
      },
      initializeFromStorage: () => {
        const saved = loadFromStorage();
        if (saved) set((s) => { s.defaults.fromStorage = saved; });
      },
      initializeRuntime: () => {
        const { fromUrl, fromStorage, hardcoded } = get().defaults;
        const runtime: AppConfig = {
          ...hardcoded,
          ...(fromStorage || {}),
          ...(fromUrl || {}),
        } as AppConfig;
        set((s) => { s.runtime = runtime; });
        saveToStorage(runtime);
      },
      updateField: (key, value) => {
        set((s) => { (s.runtime as any)[key] = value; });
        saveToStorage(get().runtime);
      },
      getEffectiveValue: (key) => {
        const { runtime, defaults } = get();
        const rVal = (runtime as any)[key];
        if (rVal !== undefined) return rVal;
        const uVal = (defaults.fromUrl as any)?.[key];
        if (uVal !== undefined) return uVal;
        const sVal = (defaults.fromStorage as any)?.[key];
        if (sVal !== undefined) return sVal;
        return (defaults.hardcoded as any)[key];
      },
    },
  }))
);

