import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { Config } from "./config.js";

// bge models are trained to embed a *search query* with this prefix and a *passage* without it.
// Queries get it, documents do not. Mixing them up quietly lowers retrieval quality.
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export type EmbedKind = "query" | "passage";

// THE one place text becomes vectors. Same idea as src/llm.ts: one door, so timing and
// logging live in one spot and the model can be swapped without touching callers.
export function createEmbedder(config: Config["embedding"], opts: { logPath?: string; cacheDir?: string } = {}) {
  env.cacheDir = opts.cacheDir ?? ".cache/models"; // gitignored; weights are downloaded once, not committed
  let extractor: Promise<FeatureExtractionPipeline> | undefined;

  const load = () =>
    (extractor ??= pipeline("feature-extraction", config.model, {
      revision: config.revision, // pinned commit, so everyone gets identical weights
      dtype: "fp32", // full precision: similarity scores feed a threshold in the semantic cache
    }) as Promise<FeatureExtractionPipeline>);

  // Returns one unit-length vector per text. Because they are normalised, cosine
  // similarity is just a dot product (see `cosine` below).
  async function embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    const model = await load();
    const input = kind === "query" ? texts.map((t) => BGE_QUERY_PREFIX + t) : texts;
    const start = performance.now();
    const out = await model(input, { pooling: "cls", normalize: true }); // bge uses the [CLS] token, not mean pooling
    const [n, dim] = out.dims as [number, number];
    const data = out.data as Float32Array;
    const vectors = Array.from({ length: n }, (_, i) => data.slice(i * dim, (i + 1) * dim));
    if (opts.logPath) {
      mkdirSync(dirname(opts.logPath), { recursive: true });
      appendFileSync(
        opts.logPath,
        JSON.stringify({ t: new Date().toISOString(), model: config.model, revision: config.revision, kind, count: n, ms: performance.now() - start }) + "\n",
      );
    }
    return vectors;
  }

  return { embed };
}

// For unit-length vectors, cosine similarity equals the dot product.
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
