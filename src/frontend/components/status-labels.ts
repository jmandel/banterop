export function statusLabel(s: string): string {
  // Team-centric copy
  if (s === 'input-required') return 'Our turn — waiting on us';
  if (s === 'working') return 'Other side working — waiting on them';
  if (s === 'submitted') return 'Not started';
  if (s === 'auth-required') return 'Authentication required';
  // pass through other statuses (completed, canceled, failed, rejected, unknown)
  return s;
}
