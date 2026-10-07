import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answerVersion, cacheKey, createExactCache, withExactCache } from "../src/cache/exact.js";
import { loadConfig } from "../src/config.js";
import type { Pipeline, PipelineResult } from "../src/pipeline.js";

const result = (answer: string): PipelineResult => ({
  answer, retrievedIds: ["0-0"], embedMs: 5, searchMs: 1, ttftMs: 900, llmMs: 1000, totalMs: 1006,
  usage: { promptTokens: 800, completionTokens: 5 }, cacheHit: false, cacheLayer: null,
});

describe("cache key", () => {
  it("is exact: any change to the question text changes the key", () => {
    expect(cacheKey("Who?", "v1")).toBe(cacheKey("Who?", "v1"));
    expect(cacheKey("Who?", "v1")).not.toBe(cacheKey("who?", "v1"));
    expect(cacheKey("Who?", "v1")).not.toBe(cacheKey("Who? ", "v1"));
  });
  it("changes with the answer version, so old entries stop matching", () => {
    expect(cacheKey("Who?", "v1")).not.toBe(cacheKey("Who?", "v2"));
  });
  it("answer version reacts to model, top-k and data changes", () => {
    const base = loadConfig("configs/base.yaml");
    const v = answerVersion(base, "data1");
    expect(answerVersion(base, "data1")).toBe(v);
    expect(answerVersion(base, "data2")).not.toBe(v);
    expect(answerVersion({ ...base, retrieval: { topK: 9 } }, "data1")).not.toBe(v);
    expect(answerVersion({ ...base, llm: { ...base.llm, modelDigest: "other" } }, "data1")).not.toBe(v);
  });
});

describe("createExactCache", () => {
  it("returns what was stored, and undefined for unknown keys", () => {
    const c = createExactCache(":memory:", { ttlSeconds: 60 });
    expect(c.get("k")).toBeUndefined();
    c.set("k", { question: "Q", answer: "A", retrievedIds: ["1-2", "3-4"] });
    expect(c.get("k")).toEqual({ question: "Q", answer: "A", retrievedIds: ["1-2", "3-4"] });
    expect(c.size()).toBe(1);
  });
  it("expires entries after the TTL", () => {
    let t = 1_000_000;
    const c = createExactCache(":memory:", { ttlSeconds: 10, now: () => t });
    c.set("k", { question: "Q", answer: "A", retrievedIds: [] });
    t += 9_999;
    expect(c.get("k")?.answer).toBe("A");
    t += 1; // exactly 10 s after it was stored
    expect(c.get("k")).toBeUndefined();
    expect(c.size()).toBe(0);
  });
  it("overwrites an existing key and restarts its TTL", () => {
    let t = 0;
    const c = createExactCache(":memory:", { ttlSeconds: 10, now: () => t });
    c.set("k", { question: "Q", answer: "old", retrievedIds: [] });
    t = 8_000;
    c.set("k", { question: "Q", answer: "new", retrievedIds: [] });
    t = 15_000; // past the first TTL, inside the second
    expect(c.get("k")?.answer).toBe("new");
  });
  it("survives a restart when backed by a file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cache-")), "c.sqlite");
    const a = createExactCache(path, { ttlSeconds: 60 });
    a.set("k", { question: "Q", answer: "A", retrievedIds: [] });
    a.close();
    expect(createExactCache(path, { ttlSeconds: 60 }).get("k")?.answer).toBe("A");
  });
});

describe("withExactCache", () => {
  const setup = () => {
    let calls = 0;
    const inner: Pipeline = async (q) => { calls++; return result(`answer to ${q}`); };
    const cache = createExactCache(":memory:", { ttlSeconds: 60 });
    return { pipeline: withExactCache(inner, cache, "v1"), calls: () => calls, cache };
  };
  it("misses first, then hits without calling the model again", async () => {
    const { pipeline, calls } = setup();
    const first = await pipeline("Who?");
    const second = await pipeline("Who?");
    expect(calls()).toBe(1);
    expect(first.cacheHit).toBe(false);
    expect(second).toMatchObject({ cacheHit: true, cacheLayer: "exact", answer: "answer to Who?", llmMs: 0, embedMs: 0 });
    expect(second.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
    expect(second.totalMs).toBeLessThan(first.totalMs);
  });
  it("treats a different string as a different question", async () => {
    const { pipeline, calls } = setup();
    await pipeline("Who?");
    await pipeline("who?");
    expect(calls()).toBe(2);
  });
  it("does not cache failures", async () => {
    let n = 0;
    const flaky: Pipeline = async () => { if (n++ === 0) throw new Error("model down"); return result("ok"); };
    const cache = createExactCache(":memory:", { ttlSeconds: 60 });
    const pipeline = withExactCache(flaky, cache, "v1");
    await expect(pipeline("Q")).rejects.toThrow("model down");
    expect(cache.size()).toBe(0);
    expect((await pipeline("Q")).answer).toBe("ok");
  });
});

describe("refusals", () => {
  it("are never cached, so the next ask runs the model again", async () => {
    let calls = 0;
    const inner: Pipeline = async () => { calls++; return { ...result(calls === 1 ? "" : "ok"), refused: calls === 1 }; };
    const cache = createExactCache(":memory:", { ttlSeconds: 60 });
    const p = withExactCache(inner, cache, "v1");
    expect((await p("Q")).refused).toBe(true);
    expect(cache.size()).toBe(0);
    expect((await p("Q")).answer).toBe("ok");
    expect(calls).toBe(2);
  });
});
