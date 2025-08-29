export function statusLabel(s: string): string {
  // Viewer-centric copy
  if (s === 'input-required') return 'Your turn — waiting for you';
  if (s === 'working') return 'Other side working — please wait';
  if (s === 'submitted') return 'Not started';
  if (s === 'auth-required') return 'Authentication required';
  // pass through other statuses (completed, canceled, failed, rejected, unknown)
  return s;
}
