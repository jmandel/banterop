import type { FieldState, SavedField } from './types';

export function applySavedFields(base: FieldState[], saved?: SavedField[]): FieldState[] {
  if (!saved || !saved.length) return base.map(cloneField);
  const map = new Map(saved.map(f => [f.key, f.value] as const));
  return base.map(f => ({ ...f, value: map.has(f.key) ? map.get(f.key) : f.value }));
}

export function toSavedFields(fields: FieldState[]): SavedField[] {
  return fields.map(f => ({ key: f.key, value: deepCloneValue(f.value) }));
}

function cloneField(f: FieldState): FieldState {
  return { ...f, options: f.options ? [...f.options] : undefined };
}

function deepCloneValue<T>(v: T): T {
  try { return JSON.parse(JSON.stringify(v)) as T; } catch { return v; }
}

