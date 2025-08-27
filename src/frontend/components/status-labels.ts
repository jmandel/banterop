export function statusLabel(s: string): string {
  if (s === 'working') return 'Remote Agent is Working';
  if (s === 'input-required') return 'Remote Agent is Waiting for Us';
  if (s === 'submitted') return 'Not started';
  // pass through other statuses (completed, canceled, failed, rejected, auth-required, unknown)
  return s;
}

