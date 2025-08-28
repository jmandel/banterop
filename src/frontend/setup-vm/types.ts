export type FieldType = 'text' | 'select' | 'checkbox' | 'checkbox-group';

export type FieldBase = {
  key: string;
  label: string;
  visible?: boolean;
  disabled?: boolean;
  error?: string | null;
  placeholder?: string;
  // Planner-private metadata (not rendered)
  meta?: any;
};

export type Field =
  | (FieldBase & { type: 'text'; value: string })
  | (FieldBase & { type: 'select'; value: string; options: Array<{ value: string; label: string }> })
  | (FieldBase & { type: 'checkbox'; value: boolean })
  | (FieldBase & { type: 'checkbox-group'; value: string[]; options: Array<{ value: string; label: string }> });

export type Patch =
  | { op: 'setFieldValue'; key: string; value: any }
  | { op: 'setFieldOptions'; key: string; options: Array<{ value: string; label: string }> }
  | { op: 'setFieldError'; key: string; error: string | null }
  | { op: 'setFieldDisabled'; key: string; disabled: boolean }
  | { op: 'setFieldVisible'; key: string; visible: boolean }
  | { op: 'setFieldMeta'; key: string; meta: any }
  | { op: 'batch'; ops: Patch[] }
  | { op: 'replaceAllFields'; fields: Field[] };

export type Event =
  | { type: 'BOOT' }
  | { type: 'FIELD_CHANGE'; key: string; value: any }
  | { type: 'ASYNC_RESULT'; token: string; data: any }
  | { type: 'ASYNC_ERROR'; token: string; error: string };

export type EffectCtx = {
  fetchJson: (url: string) => Promise<any>;
  cache: Map<string, any>;
};

export type ReduceResult = {
  patches: Patch[];
  effects?: Array<{ token: string; run: (ctx: EffectCtx) => Promise<any> }>;
};

export interface PlannerFieldsVM<Seed = unknown, Full = unknown> {
  id: string;
  baseFields(): Field[];
  reduce(current: Field[], ev: Event): ReduceResult;
  fastForward(seed: Seed, ctx: EffectCtx): Promise<{ fields: Field[]; full?: Full }>;
  validateToFull(fields: Field[]): { ok: true; full: Full } | { ok: false; errors: Array<{ key: string; msg: string }> };
  dehydrate(full: Full): Seed;
  hydrate(seed: Seed, ctx: { fetchJson: (u: string) => Promise<any>, cache: Map<string, any> }): Promise<{ full: Full }>;
}
