import { answerVersion, createExactCache, withExactCache, type ExactCache } from "../cache/exact.js";
import { createRetrievalCache, retrievalVersion, type RetrievalCache } from "../cache/retrieval.js";
import { createSemanticCache, withSemanticCache, type SemanticCache } from "../cache/semantic.js";
import type { Config } from "../config.js";
import type { createEmbedder } from "../embed.js";
import type { createLlm } from "../llm.js";
import { createPipeline, type Pipeline } from "../pipeline.js";
import type { VectorIndex } from "../rag/index.js";
import type { Paragraph } from "../rag/squad.js";

// One cache configuration to compare. Every arm gets its OWN cache state, so arms never help each other.
export interface ArmSpec {
  name: string;
  exact: boolean;
  semantic: boolean;
  retrieval: boolean;
  semanticThreshold?: number;
  retrievalThreshold?: number;
  prefix?: boolean; // place a prompt-cache breakpoint (explicit-caching providers); default off
  order?: "relevance" | "sorted"; // passage order in the prompt; default: the base config's
}

export interface ArmDeps {
  embed: ReturnType<typeof createEmbedder>["embed"];
  llm: ReturnType<typeof createLlm>;
  index: VectorIndex;
  paragraphs: Map<string, Paragraph>;
  subsetSha256: string; // data version
}

export interface BuiltArm {
  pipeline: Pipeline;
  exact?: ExactCache;
  semantic?: SemanticCache;
  retrieval?: RetrievalCache;
}

// Prompt caching is OFF in an arm unless `prefix` is set. With a server that caches by itself (Ollama) arms would help
// each other, so each arm's prompt starts with its own label (a per-request nonce for "off", a constant namespace for
// explicit-caching providers), which keeps every arm's cache entries separate.
export function armConfig(base: Config, arm: ArmSpec): Config {
  const c = structuredClone(base);
  c.caches.exact.enabled = arm.exact;
  c.caches.semantic.enabled = arm.semantic;
  c.caches.retrieval.enabled = arm.retrieval;
  if (arm.semanticThreshold !== undefined) c.caches.semantic.threshold = arm.semanticThreshold;
  if (arm.retrievalThreshold !== undefined) c.caches.retrieval.threshold = arm.retrievalThreshold;
  c.caches.promptPrefix.enabled = arm.prefix ?? false;
  if (arm.order) c.prompt.passageOrder = arm.order;
  return c;
}

// Layers, outermost first: exact -> semantic -> pipeline (with the retrieval cache inside the pipeline).
// `cacheDataVersion` is the data version the CACHES believe they hold (default: the data actually in use). Passing an
// older one simulates a cache with no invalidation after the data changed.
export function buildArm(base: Config, arm: ArmSpec, deps: ArmDeps, salt: string, cacheDataVersion = deps.subsetSha256): BuiltArm {
  const config = armConfig(base, arm);
  const version = answerVersion(config, cacheDataVersion);
  const retrieval = arm.retrieval ? createRetrievalCache({ ttlSeconds: config.caches.retrieval.ttlSeconds, threshold: config.caches.retrieval.threshold }) : undefined;
  let pipeline = createPipeline({
    config, nonceSalt: salt, cacheNamespace: salt, retrievalCache: retrieval, retrievalVersion: retrievalVersion(config, cacheDataVersion),
    embed: deps.embed, llm: deps.llm, index: deps.index, paragraphs: deps.paragraphs,
  });
  const semantic = arm.semantic
    ? createSemanticCache(":memory:", { ttlSeconds: config.caches.semantic.ttlSeconds, threshold: config.caches.semantic.threshold, version })
    : undefined;
  if (semantic) pipeline = withSemanticCache(pipeline, semantic, deps.embed);
  const exact = arm.exact ? createExactCache(":memory:", { ttlSeconds: config.caches.exact.ttlSeconds }) : undefined;
  if (exact) pipeline = withExactCache(pipeline, exact, version);
  return { pipeline, exact, semantic, retrieval };
}
