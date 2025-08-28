export type Field = {
  key: string;
  type: 'text'|'select'|'checkbox'|'checkbox-group';
  label: string;
  value: unknown;
  placeholder?: string;
  help?: string;
  required?: boolean;
  disabled?: boolean;
  visible?: boolean;
  options?: Array<{ value: string; label: string }>;
  error?: string | null;
  pending?: boolean;
  meta?: any;
};

export type Patch =
  | { op: 'replaceAllFields'; fields: Field[] }
  | { op: 'batch'; ops: Patch[] }
  | { op: 'setFieldValue'; key: string; value: unknown }
  | { op: 'setFieldOptions'; key: string; options: Array<{ value: string; label: string }> }
  | { op: 'setFieldVisible'; key: string; visible: boolean }
  | { op: 'setFieldDisabled'; key: string; disabled: boolean }
  | { op: 'setFieldError'; key: string; error: string | null }
  | { op: 'setFieldPending'; key: string; pending: boolean }
  | { op: 'setFieldMeta'; key: string; meta: any };

export type EffectToken = string;

export type Effect = {
  token: EffectToken;
  run: (ctx: { cache: Map<string, any>, fetchJson: (url: string) => Promise<any> }) => Promise<any>;
};

export type ReduceEvent =
  | { type: 'BOOT' }
  | { type: 'FIELD_CHANGE'; key: string; value: unknown }
  | { type: 'ASYNC_RESULT'; token: EffectToken; data: any }
  | { type: 'ASYNC_ERROR'; token: EffectToken; error: string };

export type ReduceResult = {
  patches?: Patch[];      // synchronous updates
  effects?: Effect[];     // fire-and-callback async jobs
};

// Aliases for backward compatibility with existing code
export type Event = ReduceEvent;
export type EffectCtx = { cache: Map<string, any>, fetchJson: (url: string) => Promise<any> };

export type PlannerFieldsVM<Seed, Full> = {
  id: string;
  baseFields(): Field[];  // initial fields
  reduce(current: Field[], ev: ReduceEvent): ReduceResult;

  // deep-link
  dehydrate(full: Full): Seed;                      // pure
  hydrate(seed: Seed, ctx: { cache: Map<string, any>, fetchJson: (url: string) => Promise<any> }):
    Promise<{ full: Full; fields?: Field[] }>;      // may fetch
  fastForward?(seed: Seed, ctx: { cache: Map<string, any>, fetchJson: (url: string) => Promise<any> }):
    Promise<{ full: Full; fields: Field[] }>;       // optional: build fields quickly

  validateToFull(fields: Field[]):
    | { ok: true; full: Full }
    | { ok: false; errors: Array<{ key: string; msg: string }> };
};
