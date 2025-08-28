import type { LlmProvider, LlmMessage } from './journal-types';

export type ValidateFn<T> = (text: string) => T; // throw if invalid

export type RetryOptions = {
  attempts?: number;           // default 3
  baseDelayMs?: number;        // default 250
  jitterMs?: number;           // default 50
  retryMessages?: LlmMessage[]; // messages to append on retry attempts (>1)
};

export function cleanModelText(text: string): string {
  return String(text || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
}

export async function chatWithValidationRetry<T>(
  llm: LlmProvider,
  req: { model?: string; messages: LlmMessage[]; temperature?: number; maxTokens?: number; signal?: AbortSignal },
  validate: ValidateFn<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = Math.max(0, opts.baseDelayMs ?? 250);
  const jitter = Math.max(0, opts.jitterMs ?? 50);
  let lastErr: any = null;

  for (let i = 1; i <= attempts; i++) {
    try {
      const augmented = i > 1 && Array.isArray(opts.retryMessages) && opts.retryMessages.length
        ? { ...req, messages: [...req.messages, ...opts.retryMessages] }
        : req;
      const { text } = await llm.chat(augmented);
      const cleaned = cleanModelText(text);
      const value = validate(cleaned);
      return value;
    } catch (e: any) {
      lastErr = e;
      if (i < attempts) {
        const delay = base * Math.pow(2, i - 1) + Math.floor(Math.random() * jitter);
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
    }
  }

  throw (lastErr instanceof Error ? lastErr : new Error(String(lastErr || 'LLM validation failed')));
}

