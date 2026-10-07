import { describe, expect, it } from "vitest";
import { isTransient, withRetries } from "../src/eval/retry.js";
import type { Pipeline, PipelineResult } from "../src/pipeline.js";

const ok: PipelineResult = { answer: "a", retrievedIds: [], embedMs: 0, searchMs: 0, ttftMs: 0, llmMs: 0, totalMs: 0, usage: { promptTokens: 1, completionTokens: 1 }, cacheHit: false, cacheLayer: null };
const failing = (times: number, error: unknown): { p: Pipeline; calls: () => number } => {
  let n = 0;
  return { calls: () => n, p: async () => { if (n++ < times) throw error; return ok; } };
};

describe("isTransient", () => {
  it("retries rate limits, server errors and connection problems", () => {
    expect(isTransient({ status: 429 })).toBe(true);
    expect(isTransient({ status: 529 })).toBe(true);
    expect(isTransient({ status: 503 })).toBe(true);
    expect(isTransient({ name: "APIConnectionError", message: "Connection error." })).toBe(true);
  });
  it("does not retry client errors", () => {
    expect(isTransient({ status: 400 })).toBe(false);
    expect(isTransient({ status: 401 })).toBe(false);
    expect(isTransient(new Error("the model refused this request (stop_reason: refusal)"))).toBe(false);
  });
});

describe("withRetries", () => {
  it("recovers from transient failures and reports each retry", async () => {
    const f = failing(2, { status: 529 });
    const seen: number[] = [];
    const r = await withRetries(f.p, { baseDelayMs: 1, onRetry: (a) => seen.push(a) })("q");
    expect(r.answer).toBe("a");
    expect(f.calls()).toBe(3);
    expect(seen).toEqual([1, 2]);
  });
  it("gives up after the allowed number of tries", async () => {
    const f = failing(10, { status: 500 });
    await expect(withRetries(f.p, { tries: 3, baseDelayMs: 1 })("q")).rejects.toMatchObject({ status: 500 });
    expect(f.calls()).toBe(3);
  });
  it("fails immediately on a non-transient error", async () => {
    const f = failing(10, { status: 400 });
    await expect(withRetries(f.p, { baseDelayMs: 1 })("q")).rejects.toMatchObject({ status: 400 });
    expect(f.calls()).toBe(1);
  });
});
