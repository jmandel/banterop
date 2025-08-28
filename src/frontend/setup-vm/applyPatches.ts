import type { Field, Patch } from './types';

function cloneField(f: Field): Field {
  const base = { ...f, meta: f.meta ? JSON.parse(JSON.stringify(f.meta)) : undefined } as any;
  if ('options' in base && Array.isArray(base.options)) {
    base.options = base.options.map((o: any) => ({ ...o }));
  }
  return base;
}

function findField(fields: Field[], key: string): Field | undefined {
  return fields.find(f => f.key === key);
}

export function applyPatches(current: Field[], patches: Patch[]): Field[] {
  let fields = current.map(cloneField);

  const apply = (p: Patch) => {
    if (p.op === 'replaceAllFields') {
      fields = p.fields.map(cloneField);
      return;
    }

    if (p.op === 'batch') {
      for (const q of p.ops) apply(q);
      return;
    }

    const f = findField(fields, p.key);
    if (!f) return;

    switch (p.op) {
      case 'setFieldValue':
        (f as any).value = p.value;
        break;
      case 'setFieldOptions':
        (f as any).options = p.options;
        break;
      case 'setFieldError':
        f.error = p.error;
        break;
      case 'setFieldDisabled':
        f.disabled = p.disabled;
        break;
      case 'setFieldVisible':
        f.visible = p.visible;
        break;
      case 'setFieldMeta':
        f.meta = p.meta;
        break;
    }
  };

  for (const p of patches) apply(p);
  return fields;
}
