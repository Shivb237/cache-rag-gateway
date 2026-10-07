import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSemanticCache, withSemanticCache } from "../src/cache/semantic.js";
import type { Pipeline, PipelineResult } from "../src/pipeline.js";

const unit = (...xs: number[]) => { const n = Math.hypot(...xs); return Float32Array.from(xs.map((x) => x / n)); };
const entry = (answer: string, question = "Q") => ({ question, answer, retrievedIds: ["0-0"] });
const opts = { ttlSeconds: 60, threshold: 0.9, version: "v1" };

describe("createSemanticCache", () => {
  it("finds the nearest entry and reports its similarity", () => {
    const c = createSemanticCache(":memory:", opts);
    c.set(unit(1, 0), entry("east"));
    c.set(unit(0, 1), entry("north"));
    const m = c.nearest(unit(0.1, 1))!;
    expect(m.entry.answer).toBe("north");
    expect(m.score).toBeGreaterThan(0.99);
    expect(c.nearest(unit(1, 0))!.score).toBeCloseTo(1);
  });
  it("returns the best entry even below the threshold (the caller decides)", () => {
    const c = createSemanticCache(":memory:", opts);
    c.set(unit(1, 0), entry("east"));
    const m = c.nearest(unit(1, 1))!; // 45 degrees away: similarity about 0.707
    expect(m.score).toBeCloseTo(Math.SQRT1_2);
    expect(m.score).toBeLessThan(c.threshold);
  });
  it("ignores expired entries", () => {
    let t = 0;
    const c = createSemanticCache(":memory:", { ...opts, ttlSeconds: 10, now: () => t });
    c.set(unit(1, 0), entry("a"));
    t = 10_000;
    expect(c.nearest(unit(1, 0))).toBeUndefined();
    expect(c.size()).toBe(0);
  });
  it("survives a restart, and drops entries made under another version", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sem-")), "s.sqlite");
    const a = createSemanticCache(path, opts);
    a.set(unit(1, 2, 3), entry("kept"));
    a.close();
    const same = createSemanticCache(path, opts);
    const m = same.nearest(unit(1, 2, 3))!;
    expect(m.entry.answer).toBe("kept");
    expect(m.score).toBeCloseTo(1, 5);
    same.close();
    expect(createSemanticCache(path, { ...opts, version: "v2" }).nearest(unit(1, 2, 3))).toBeUndefined();
  });
});

describe("withSemanticCache", () => {
  const result = (answer: string): PipelineResult => ({
    answer, retrievedIds: ["0-0"], embedMs: 10, searchMs: 1, ttftMs: 900, llmMs: 1000, totalMs: 1011,
    usage: { promptTokens: 800, completionTokens: 5 }, cacheHit: false, cacheLayer: null,
  });
  // Fake embedder: the vector depends on the text, so we control similarity.
  const vectors: Record<string, Float32Array> = {
    "How tall is it?": unit(1, 0), "What is its height?": unit(0.97, 0.243), "Who built it?": unit(0, 1),
  };
  const embed = async (texts: string[]) => texts.map((t) => vectors[t]!);
  const setup = () => {
    let calls = 0;
    const inner: Pipeline = async (q) => { calls++; return result(`answer to ${q}`); };
    const cache = createSemanticCache(":memory:", opts);
    return { pipeline: withSemanticCache(inner, cache, embed), calls: () => calls, cache };
  };
  it("serves a close paraphrase from the cache without calling the model", async () => {
    const { pipeline, calls } = setup();
    await pipeline("How tall is it?");
    const hit = await pipeline("What is its height?");
    expect(calls()).toBe(1);
    expect(hit).toMatchObject({ cacheHit: true, cacheLayer: "semantic", answer: "answer to How tall is it?", cachedQuestion: "How tall is it?", llmMs: 0 });
    expect(hit.cacheScore).toBeGreaterThan(0.9);
    expect(hit.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
  it("calls the model for an unrelated question and caches that too", async () => {
    const { pipeline, calls, cache } = setup();
    await pipeline("How tall is it?");
    const miss = await pipeline("Who built it?");
    expect(calls()).toBe(2);
    expect(miss.cacheHit).toBe(false);
    expect(miss.cacheScore).toBeLessThan(0.9);
    expect(cache.size()).toBe(2);
  });
  it("counts embedding time on a miss, so the overhead is visible", async () => {
    const { pipeline } = setup();
    const miss = await pipeline("How tall is it?");
    expect(miss.embedMs).toBeGreaterThan(10); // the inner 10 ms plus the lookup embedding
    expect(miss.totalMs).toBeGreaterThan(0);
  });
  it("does not cache failures", async () => {
    const cache = createSemanticCache(":memory:", opts);
    const pipeline = withSemanticCache(async () => { throw new Error("down"); }, cache, embed);
    await expect(pipeline("How tall is it?")).rejects.toThrow("down");
    expect(cache.size()).toBe(0);
  });
});

describe("semantic cache versions", () => {
  it("a view under a new version ignores older entries and keeps its own", () => {
    const c = createSemanticCache(":memory:", opts);
    c.set(unit(1, 0), entry("old"));
    const v2 = c.withVersion("v2");
    expect(v2.nearest(unit(1, 0))).toBeUndefined(); // data changed: the v1 answer is not served
    v2.set(unit(1, 0), entry("new"));
    expect(v2.nearest(unit(1, 0))!.entry.answer).toBe("new");
    expect(c.nearest(unit(1, 0))!.entry.answer).toBe("old"); // the original version still sees only its own entries
    expect(c.size()).toBe(1);
    expect(v2.size()).toBe(1);
  });
});

describe("semantic cache and refusals", () => {
  it("does not store a refused answer", async () => {
    const cache = createSemanticCache(":memory:", opts);
    const inner: Pipeline = async () => ({ answer: "", retrievedIds: [], embedMs: 1, searchMs: 1, ttftMs: 1, llmMs: 1, totalMs: 1, usage: { promptTokens: 1, completionTokens: 0 }, cacheHit: false, cacheLayer: null, refused: true });
    const p = withSemanticCache(inner, cache, async () => [unit(1, 0)]);
    await p("How tall is it?");
    expect(cache.size()).toBe(0);
  });
});
