// Shared config UI types for planner setup
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

export type ConfigSnapshot = {
  fields: FieldState[];
  canSave: boolean;   // OK to Save
  pending: boolean;   // any async validations running
  dirty: boolean;     // differs from last-applied
  summary?: string;   // short text for collapsed header
  preview?: unknown;  // planner-defined preview blob
};

