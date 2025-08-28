// New simplified config types for the cleaner architecture
export type FieldType = 'text' | 'select' | 'checkbox' | 'checkbox-group';

export type FieldOption = { value: string; label: string };

export type FieldState = {
  key: string;
  type: FieldType;
  label: string;
  value: unknown;
  placeholder?: string;
  help?: string;
  required?: boolean;
  disabled?: boolean;
  visible?: boolean; // default true
  options?: FieldOption[]; // for select/checkbox-group
  error?: string | null;
  pending?: boolean;
};

// Serialized, portable representation for persistence/deep-linking
export type SavedField = { key: string; value: unknown };

export type ConfigSnapshot = {
  fields: FieldState[];
  canSave: boolean;   // OK to Save
  pending: boolean;   // any async validations running
  dirty: boolean;     // differs from last-applied
  summary?: string;   // short text for collapsed header
  preview?: unknown;  // planner-defined preview blob
};

// Generic config store interface
export type PlannerConfigStore = {
  // state
  snap: ConfigSnapshot;

  // actions
  setField: (key: string, value: unknown) => void;
  exportConfig: () => { config: any; ready: boolean };
  initialize?: (values: Record<string, unknown>) => Promise<void>;
  destroy: () => void;
  // subscribe for React reactivity
  subscribe: (listener: () => void) => () => void;
};

// Helper function to create initial field state
export function createFieldState(definition: any): FieldState {
  return {
    key: definition.key,
    type: definition.type,
    label: definition.label,
    value: definition.defaultValue || '',
    placeholder: definition.placeholder,
    help: definition.help,
    required: definition.required,
    visible: definition.visible !== false,
    options: definition.options || [],
    error: null,
    pending: false,
  };
}

// Helper function to update field in array
export function updateField(fields: FieldState[], key: string, value: unknown, error?: string | null): FieldState[] {
  return fields.map(f =>
    f.key === key
      ? { ...f, value, error: error !== undefined ? error : f.error, pending: false }
      : f
  );
}
