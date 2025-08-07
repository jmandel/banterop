// Minimal console-based logging with timing utilities
// No external dependencies - pure console output

export function ts(): string {
  const now = new Date();
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return now.toTimeString().slice(0, 8) + '.' + ms;
}

export function dur(startMs: number): string {
  const elapsed = Date.now() - startMs;
  if (elapsed < 1000) return `${elapsed}ms`;
  if (elapsed < 60000) return `${(elapsed / 1000).toFixed(1)}s`;
  return `${(elapsed / 60000).toFixed(1)}m`;
}

export function truncate(str: string, maxLen = 120): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

export class PerfTimer {
  private timers = new Map<string, number>();
  
  start(label: string): void {
    this.timers.set(label, Date.now());
  }
  
  end(label: string): string {
    const start = this.timers.get(label);
    if (!start) return '???';
    this.timers.delete(label);
    return dur(start);
  }
  
  checkpoint(label: string): string {
    const start = this.timers.get(label);
    if (!start) return '???';
    return dur(start);
  }
}

// Colored output helpers (works in Bun/Node terminals)
export const colors = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bright: (s: string) => `\x1b[97m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

// Structured log line formatter
export function logLine(
  component: string,
  action: string,
  details?: string,
  timing?: string
): void {
  const timestamp = colors.dim(`[${ts()}]`);
  const comp = colors.cyan(`[${component}]`);
  const act = colors.bright(action);
  const det = details ? ` ${details}` : '';
  const time = timing ? colors.yellow(` (${timing})`) : '';
  
  console.log(`${timestamp}${comp} ${act}${det}${time}`);
}