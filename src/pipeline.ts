import type { Config } from "./config.js";
import type { createEmbedder } from "./embed.js";
import type { createLlm } from "./llm.js";
import { buildMessages } from "./rag/generate.js";
import type { RetrievalCache } from "./cache/retrieval.js";
import { search, type VectorIndex } from "./rag/index.js";
import type { Paragraph } from "./rag/squad.js";
import type { Usage } from "./providers/index.js";

export interface PipelineDeps {
  config: Config;
  nonceSalt?: string; // makes the cache-defeating word unique to one run (so two runs can never share a prompt)
  cacheNamespace?: string; // explicit-caching providers: a constant label at the start of the prompt, so this arm's cache entries are its own
  embed: ReturnType<typeof createEmbedder>["embed"];
  llm: ReturnType<typeof createLlm>;
  index: VectorIndex;
  paragraphs: Map<string, Paragraph>;
  retrievalCache?: RetrievalCache; // optional layer: reuse a similar earlier query's passage list
  retrievalVersion?: string; // data/retrieval version the cache entries must match
}

export interface PipelineResult {
  answer: string;
  retrievedIds: string[];
  embedMs: number;
  searchMs: number;
  ttftMs: number; // time to first answer token (from the LLM call)
  llmMs: number;
  totalMs: number; // whole question, start to finish
  usage: Usage;
  cacheHit: boolean; // true when a cache layer answered without running the model
  cacheLayer: "exact" | "semantic" | null; // which layer answered (more layers come in later milestones)
  cacheScore?: number; // semantic layer: similarity to the nearest cached question
  cachedQuestion?: string; // semantic layer: the cached question whose answer was served
  retrievalHit?: boolean; // the passage list came from the retrieval cache, not a vector search
  retrievalScore?: number; // similarity to the nearest cached query (also reported on retrieval misses)
  costUsd?: number; // what the model call cost (absent or 0 for cache hits)
  refused?: boolean; // the model declined to answer; the answer is empty and must not be cached
}

export type Pipeline = (question: string, meta?: Record<string, unknown>) => Promise<PipelineResult>;

// The uncached path: embed the question, retrieve top-k paragraphs, ask the model.
// Cache layers will later wrap this function without changing it, so the eval harness
// can measure any combination of layers through the same Pipeline type.
export function createPipeline(deps: PipelineDeps): Pipeline {
  let requestCounter = 0;
  return async (question, meta = {}) => {
    const t0 = performance.now();
    const [qv] = await deps.embed([question], "query");
    const t1 = performance.now();
    // Retrieval cache: a similar earlier query's passage list is reused instead of searching.
    const version = deps.retrievalVersion ?? "none";
    const near = deps.retrievalCache?.nearest(qv!, version);
    const retrievalHit = !!near && near.score >= deps.retrievalCache!.threshold;
    const hits = retrievalHit ? near!.ids.map((id) => ({ id, score: NaN })) : search(deps.index, qv!, deps.config.retrieval.topK);
    if (deps.retrievalCache && !retrievalHit) deps.retrievalCache.set(qv!, question, hits.map((h) => h.id), version);
    const t2 = performance.now();
    // retrievedIds stays in relevance order (for recall); the prompt can use a canonical order instead.
    const promptIds = deps.config.prompt.passageOrder === "sorted" ? hits.map((h) => h.id).sort() : hits.map((h) => h.id);
    const passages = promptIds.map((id) => deps.paragraphs.get(id)!);
    // Prefix caching. On a server that caches by itself (Ollama), "off" defeats it with a per-request nonce word.
    // On a provider with explicit caching (Claude API), "on" places a cache breakpoint after the passages and
    // "off" simply places none.
    const prefixOn = deps.config.caches.promptPrefix.enabled;
    const explicit = deps.llm.cacheMode === "explicit";
    const nonce = explicit ? deps.cacheNamespace : !prefixOn ? `${deps.nonceSalt ?? "x"}-${++requestCounter}` : undefined;
    const r = await deps.llm.complete(buildMessages(question, passages, { nonce, cacheMarkers: prefixOn && explicit }), meta);
    const t3 = performance.now();
    return {
      answer: r.text.trim(),
      retrievedIds: hits.map((h) => h.id),
      embedMs: t1 - t0,
      searchMs: t2 - t1,
      ttftMs: r.ttftMs,
      llmMs: r.totalMs,
      totalMs: t3 - t0,
      usage: r.usage,
      costUsd: r.costUsd,
      refused: r.usage.stopReason === "refusal",
      cacheHit: false,
      cacheLayer: null,
      ...(deps.retrievalCache && { retrievalHit, retrievalScore: near?.score }),
    };
  };
}
