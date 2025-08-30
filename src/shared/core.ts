export const A2A_EXT_URL = 'https://banterop.fhir.me/a2a-ext';

export function nowIso(): string { return new Date().toISOString(); }
export function rid(prefix = 'id'): string { return `${prefix}-${crypto.randomUUID()}`; }

export type NextState = import('./a2a-types').A2ANextState;
