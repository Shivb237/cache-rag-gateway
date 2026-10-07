import { describe, expect, it } from "vitest";
import { createRetrievalCache, retrievalVersion } from "../src/cache/retrieval.js";
import { loadConfig } from "../src/config.js";
import { createLlm } from "../src/llm.js";
import { createPipeline } from "../src/pipeline.js";
import type { LlmProvider } from "../src/providers/index.js";
import type { VectorIndex } from "../src/rag/index.js";

const unit = (...xs: number[]) => { const n = Math.hypot(...xs); return Float32Array.from(xs.map((x) => x / n)); };

describe("createRetrievalCache", () => {
  it("returns the nearest entry of the same version, and nothing for another version", () => {
    const c = createRetrievalCache({ ttlSeconds: 60, threshold: 0.9 });
    c.set(unit(1, 0), "q1", ["a", "b"], "v1");
    c.set(unit(0, 1), "q2", ["c"], "v1");
    expect(c.nearest(unit(1, 0.1), "v1")).toMatchObject({ ids: ["a", "b"], query: "q1" });
    expect(c.nearest(unit(1, 0.1), "v2")).toBeUndefined(); // data changed: invalidated
  });
  it("expires entries after the TTL", () => {
    let t = 0;
    const c = createRetrievalCache({ ttlSeconds: 10, threshold: 0.9, now: () => t });
    c.set(unit(1, 0), "q", ["a"], "v1");
    t = 10_000;
    expect(c.nearest(unit(1, 0), "v1")).toBeUndefined();
    expect(c.size()).toBe(0);
  });
  it("version reacts to a data change and to top-k", () => {
    const cfg = loadConfig("configs/base.yaml");
    expect(retrievalVersion(cfg, "d1")).toBe(retrievalVersion(cfg, "d1"));
    expect(retrievalVersion(cfg, "d1")).not.toBe(retrievalVersion(cfg, "d2"));
    expect(retrievalVersion({ ...cfg, retrieval: { topK: 9 } }, "d1")).not.toBe(retrievalVersion(cfg, "d1"));
  });
});

describe("pipeline with a retrieval cache", () => {
  const paragraphs = new Map(["a", "b", "c"].map((id) => [id, { id, title: "T", text: `text ${id}` }]));
  const index: VectorIndex = { meta: { model: "m", revision: "r", dim: 2, count: 3, subsetSha256: "s" }, ids: ["a", "b", "c"], vectors: [unit(1, 0), unit(0, 1), unit(1, 1)] };
  const provider: LlmProvider = { name: "fake", async *stream() { yield { type: "token", text: "ok" }; yield { type: "done", usage: { promptTokens: 1, completionTokens: 1 } }; } };
  const vecs: Record<string, Float32Array> = { "q one": unit(1, 0.05), "q similar": unit(1, 0.2), "q far": unit(0.1, 1) };
  const make = (version: string, cache = createRetrievalCache({ ttlSeconds: 60, threshold: 0.95 })) => {
    const config = loadConfig("configs/base.yaml"); config.retrieval.topK = 2;
    return { cache, pipeline: createPipeline({ config, embed: async (t) => t.map((x) => vecs[x]!), llm: createLlm(config, { provider }), index, paragraphs, retrievalCache: cache, retrievalVersion: version }) };
  };
  it("a similar query reuses the earlier passage list; an unrelated one searches", async () => {
    const { pipeline } = make("v1");
    const first = await pipeline("q one");
    const similar = await pipeline("q similar");
    const far = await pipeline("q far");
    expect(first.retrievalHit).toBe(false);
    expect(similar.retrievalHit).toBe(true);
    expect(similar.retrievedIds).toEqual(first.retrievedIds); // same passages, so the same prompt start
    expect(similar.retrievalScore).toBeGreaterThan(0.95);
    expect(far.retrievalHit).toBe(false);
    expect(far.retrievedIds).not.toEqual(first.retrievedIds);
  });
  it("a new data version ignores old entries", async () => {
    const shared = createRetrievalCache({ ttlSeconds: 60, threshold: 0.95 });
    await make("v1", shared).pipeline("q one");
    const afterUpdate = await make("v2", shared).pipeline("q similar");
    expect(afterUpdate.retrievalHit).toBe(false);
  });
  it("without a cache the result carries no retrieval fields", async () => {
    const config = loadConfig("configs/base.yaml");
    const p = createPipeline({ config, embed: async (t) => t.map((x) => vecs[x]!), llm: createLlm(config, { provider }), index, paragraphs });
    expect((await p("q one")).retrievalHit).toBeUndefined();
  });
});
