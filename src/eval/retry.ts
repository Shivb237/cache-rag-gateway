import type { Pipeline } from "../pipeline.js";

// Rate limits, server errors and dropped connections are worth retrying; a bad request or a refusal is not.
export function isTransient(e: unknown): boolean {
  const err = e as { status?: number; name?: string; message?: string; code?: string };
  if (typeof err.status === "number") return err.status === 408 || err.status === 409 || err.status === 429 || err.status >= 500;
  return /connection|timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT|overloaded/i.test(`${err.name} ${err.message} ${err.code}`);
}

export function withRetries(inner: Pipeline, opts: { tries?: number; baseDelayMs?: number; onRetry?: (attempt: number, e: unknown) => void } = {}): Pipeline {
  const tries = opts.tries ?? 4;
  const base = opts.baseDelayMs ?? 2000;
  return async (question, meta) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await inner(question, meta);
      } catch (e) {
        if (!isTransient(e) || attempt >= tries) throw e;
        opts.onRetry?.(attempt, e);
        await new Promise((r) => setTimeout(r, base * 2 ** (attempt - 1)));
      }
    }
  };
}
