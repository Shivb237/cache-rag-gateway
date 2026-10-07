import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import type { Pipeline } from "../pipeline.js";
import { SYSTEM_PROMPT } from "../rag/generate.js";

export interface CacheEntry {
  question: string;
  answer: string;
  retrievedIds: string[];
}

// Everything that can change an answer must be part of the cache key. If any of these
// change, old entries simply stop matching, so a cache can never serve an answer made by
// a different model, prompt, retrieval setting or dataset.
export function answerVersion(config: Config, subsetSha256: string): string {
  return createHash("sha256")
    .update(JSON.stringify({
      model: config.llm.model, digest: config.llm.modelDigest, temperature: config.llm.temperature, seed: config.seed,
      embedding: config.embedding, topK: config.retrieval.topK, prompt: SYSTEM_PROMPT, passageOrder: config.prompt.passageOrder, subsetSha256,
    }))
    .digest("hex");
}

// Exact match: the question text must be identical, character for character.
export function cacheKey(question: string, version: string): string {
  return createHash("sha256").update(`${version}\n${question}`).digest("hex");
}

export interface ExactCache {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  size(): number; // entries that have not expired
  close(): void;
}

// SQLite-backed. `path` can be a file (survives restarts) or ":memory:". `now` is injectable so tests can move the clock.
export function createExactCache(path: string, opts: { ttlSeconds: number; now?: () => number }): ExactCache {
  const now = opts.now ?? Date.now;
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS exact_cache (
    key TEXT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL,
    retrieved_ids TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
  const getStmt = db.prepare("SELECT question, answer, retrieved_ids, expires_at FROM exact_cache WHERE key = ?");
  const delStmt = db.prepare("DELETE FROM exact_cache WHERE key = ?");
  const setStmt = db.prepare("INSERT OR REPLACE INTO exact_cache (key, question, answer, retrieved_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)");
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM exact_cache WHERE expires_at > ?");

  return {
    get(key) {
      const row = getStmt.get(key) as { question: string; answer: string; retrieved_ids: string; expires_at: number } | undefined;
      if (!row) return undefined;
      if (row.expires_at <= now()) { // expired: remove lazily, report a miss
        delStmt.run(key);
        return undefined;
      }
      return { question: row.question, answer: row.answer, retrievedIds: JSON.parse(row.retrieved_ids) as string[] };
    },
    set(key, entry) {
      const t = now();
      setStmt.run(key, entry.question, entry.answer, JSON.stringify(entry.retrievedIds), t, t + opts.ttlSeconds * 1000);
    },
    size: () => (countStmt.get(now()) as { n: number }).n,
    close: () => db.close(),
  };
}

// Wraps any pipeline. A hit skips embedding, retrieval and the model entirely.
// Failures are never cached: if `inner` throws, nothing is stored.
export function withExactCache(inner: Pipeline, cache: ExactCache, version: string): Pipeline {
  return async (question, meta) => {
    const t0 = performance.now();
    const key = cacheKey(question, version);
    const hit = cache.get(key);
    if (hit) {
      const ms = performance.now() - t0;
      return {
        answer: hit.answer, retrievedIds: hit.retrievedIds, embedMs: 0, searchMs: 0,
        ttftMs: ms, llmMs: 0, totalMs: ms, usage: { promptTokens: 0, completionTokens: 0 },
        cacheHit: true, cacheLayer: "exact",
      };
    }
    const result = await inner(question, meta);
    if (result.refused) return result; // never cache a refusal
    cache.set(key, { question, answer: result.answer, retrievedIds: result.retrievedIds });
    return result;
  };
}
