import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLlm } from "../src/llm.js";
import { createPipeline } from "../src/pipeline.js";
import { buildMessages } from "../src/rag/generate.js";
import type { ChatMessage, LlmProvider } from "../src/providers/index.js";
import type { VectorIndex } from "../src/rag/index.js";

const unit = (...xs: number[]) => { const n = Math.hypot(...xs); return Float32Array.from(xs.map((x) => x / n)); };
const paragraphs = new Map(["b", "a", "c"].map((id) => [id, { id, title: "T", text: `text ${id}` }]));
const index: VectorIndex = { meta: { model: "m", revision: "r", dim: 2, count: 3, subsetSha256: "s" }, ids: ["a", "b", "c"], vectors: [unit(1, 0.1), unit(1, 0.5), unit(1, 1)] };

function setup(over: { order?: "relevance" | "sorted"; prefixOn?: boolean }) {
  const config = loadConfig("configs/base.yaml");
  config.prompt.passageOrder = over.order ?? "relevance";
  config.caches.promptPrefix.enabled = over.prefixOn ?? true;
  config.retrieval.topK = 3;
  const seen: ChatMessage[][] = [];
  const provider: LlmProvider = { name: "fake", async *stream(req) { seen.push(req.messages); yield { type: "token", text: "ok" }; yield { type: "done", usage: { promptTokens: 1, completionTokens: 1 } }; } };
  const pipeline = createPipeline({ config, embed: async () => [unit(1, 1)], llm: createLlm(config, { provider }), index, paragraphs });
  return { pipeline, seen };
}

describe("prompt layout", () => {
  it("relevance order puts the best match first; sorted order is canonical but recall order is unchanged", async () => {
    const rel = setup({ order: "relevance" });
    const r1 = await rel.pipeline("Q?");
    expect(r1.retrievedIds).toEqual(["c", "b", "a"]);
    expect(rel.seen[0]![1]!.content.startsWith("[1] text c")).toBe(true);
    const sorted = setup({ order: "sorted" });
    const r2 = await sorted.pipeline("Q?");
    expect(r2.retrievedIds).toEqual(["c", "b", "a"]); // goldRank still sees relevance order
    expect(sorted.seen[0]![1]!.content.startsWith("[1] text a\n\n[2] text b\n\n[3] text c")).toBe(true);
  });
  it("with the prefix cache on, the instruction is byte-identical on every request", async () => {
    const { pipeline, seen } = setup({ prefixOn: true });
    await pipeline("Q1?"); await pipeline("Q2?");
    expect(seen[0]![0]!.content).toBe(seen[1]![0]!.content);
  });
  it("with the prefix cache off, every request starts with a different word", async () => {
    const { pipeline, seen } = setup({ prefixOn: false });
    await pipeline("Q1?"); await pipeline("Q2?");
    expect(seen[0]![0]!.content).not.toBe(seen[1]![0]!.content);
    expect(seen[0]![0]!.content.startsWith("[session x-1] ")).toBe(true);
  });
  it("a run-specific salt keeps two runs from ever sharing a prompt", async () => {
    const a = setup({ prefixOn: false }); const b = setup({ prefixOn: false });
    await a.pipeline("Q?"); await b.pipeline("Q?");
    expect(a.seen[0]![0]!.content).toBe(b.seen[0]![0]!.content); // without a salt they collide: this is the bug the salt fixes
  });
  it("an explicit-caching provider gets a constant per-arm namespace and a breakpoint only when caching is on", async () => {
    const config = loadConfig("configs/base.yaml");
    config.retrieval.topK = 3;
    const seen: ChatMessage[][] = [];
    const provider: LlmProvider = { name: "fake", cacheMode: "explicit", async *stream(req) { seen.push(req.messages); yield { type: "token", text: "ok" }; yield { type: "done", usage: { promptTokens: 1, completionTokens: 1 } }; } };
    const make = (prefixOn: boolean, ns: string) => { const c = structuredClone(config); c.caches.promptPrefix.enabled = prefixOn; return createPipeline({ config: c, cacheNamespace: ns, embed: async () => [unit(1, 1)], llm: createLlm(c, { provider }), index, paragraphs }); };
    await make(true, "armA")("Q1?"); await make(true, "armA")("Q2?"); await make(false, "armB")("Q1?");
    expect(seen[0]![0]!.content.startsWith("[session armA] ")).toBe(true);
    expect(seen[1]![0]!.content).toBe(seen[0]![0]!.content); // constant, so entries of the same arm can be shared
    expect(seen[2]![0]!.content.startsWith("[session armB] ")).toBe(true); // another arm: another namespace
    expect(seen[0]![1]!.parts?.[0]?.cache).toBe(true); // breakpoint when on
    expect(seen[2]![1]!.parts).toBeUndefined(); // none when off
  });
  it("buildMessages without a nonce is unchanged", () => {
    expect(buildMessages("Who?", [{ id: "0-0", title: "T", text: "A." }])[0]!.content.startsWith("You answer")).toBe(true);
  });
});
