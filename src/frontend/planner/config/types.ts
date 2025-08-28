// Clean config system types
export type FieldType = 'text' | 'select' | 'checkbox' | 'checkbox-group';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldState {
  key: string;
  type: FieldType;
  label: string;
  value: unknown;
  placeholder?: string;
  help?: string;
  required?: boolean;
  disabled?: boolean;
  visible?: boolean;
  options?: FieldOption[];
  error?: string | null;
  pending?: boolean;
}

export interface ConfigSnapshot {
  fields: FieldState[];
  canSave: boolean;
  pending: boolean;
  dirty: boolean;
  summary?: string;
  preview?: unknown;
}

export interface SavedField {
  key: string;
  value: unknown;
}

export type PlannerConfigStore = {
  snap: ConfigSnapshot;
  setField: (key: string, value: unknown) => void;
  exportConfig: () => { config: any; ready: boolean; savedFields: SavedField[] };
  destroy: () => void;
  subscribe: (listener: () => void) => () => void;
};
