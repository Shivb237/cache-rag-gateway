import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { cosine } from "../embed.js";

export interface RetrievalMatch {
  ids: string[]; // the passage ids the earlier, similar query retrieved
  score: number; // cosine similarity between the two queries
  query: string; // the earlier query's text
}

export interface RetrievalCache {
  readonly threshold: number;
  nearest(queryVec: Float32Array, version: string): RetrievalMatch | undefined; // best live entry of this data version, even below the threshold
  set(queryVec: Float32Array, query: string, ids: string[], version: string): void;
  size(): number; // entries that have not expired (any version)
}

// What a cached passage list depends on: the retrieval setup and the data, NOT the model or prompt.
// If the data changes the version changes, and old entries stop matching (invalidation by data version).
export function retrievalVersion(config: Config, subsetSha256: string): string {
  return createHash("sha256").update(JSON.stringify({ embedding: config.embedding, topK: config.retrieval.topK, subsetSha256 })).digest("hex");
}

interface Entry { vec: Float32Array; query: string; ids: string[]; version: string; expiresAt: number }

// Keyed by query SIMILARITY, not exact text. A hit gives a new query the passage list of a similar earlier query,
// skipping the vector search and making the prompt's passages (and so its prefix) identical for related questions.
// Kept in memory: persistence would follow the same pattern as the semantic cache.
export function createRetrievalCache(opts: { ttlSeconds: number; threshold: number; now?: () => number }): RetrievalCache {
  const now = opts.now ?? Date.now;
  const entries: Entry[] = [];
  return {
    threshold: opts.threshold,
    nearest(queryVec, version) {
      const t = now();
      let best: RetrievalMatch | undefined;
      for (const e of entries) {
        if (e.expiresAt <= t || e.version !== version) continue;
        const score = cosine(e.vec, queryVec);
        if (!best || score > best.score) best = { ids: e.ids, score, query: e.query };
      }
      return best;
    },
    set(vec, query, ids, version) {
      entries.push({ vec, query, ids, version, expiresAt: now() + opts.ttlSeconds * 1000 });
    },
    size: () => entries.filter((e) => e.expiresAt > now()).length,
  };
}
