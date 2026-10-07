import { DatabaseSync } from "node:sqlite";
import { cosine } from "../embed.js";
import type { Pipeline } from "../pipeline.js";
import type { CacheEntry } from "./exact.js";

type EmbedFn = (texts: string[], kind: "query" | "passage") => Promise<Float32Array[]>;

export interface SemanticMatch {
  entry: CacheEntry;
  score: number; // cosine similarity to the query
}

export interface SemanticCache {
  readonly threshold: number;
  nearest(queryVec: Float32Array): SemanticMatch | undefined; // best non-expired entry, even if below the threshold (useful for diagnostics)
  set(vec: Float32Array, entry: CacheEntry): void;
  size(): number; // entries that have not expired
  close(): void;
  // A view of the same entries under another data version: entries made under any other version are ignored,
  // so moving to a new version invalidates everything older without deleting it.
  withVersion(version: string): SemanticCache;
}

interface Stored extends CacheEntry {
  vec: Float32Array;
  expiresAt: number;
  version: string;
}

// Entries live in memory for fast scanning and in SQLite so they survive restarts.
// `version` is the same answer-version string the exact cache uses: entries made under a different
// model, prompt or dataset are ignored (and removed on open), never served.
export function createSemanticCache(
  path: string,
  opts: { ttlSeconds: number; threshold: number; version: string; now?: () => number },
): SemanticCache {
  const now = opts.now ?? Date.now;
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS semantic_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
    retrieved_ids TEXT NOT NULL, vec BLOB NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
  db.prepare("DELETE FROM semantic_cache WHERE version != ? OR expires_at <= ?").run(opts.version, now());

  const entries: Stored[] = (db.prepare("SELECT question, answer, retrieved_ids, vec, expires_at FROM semantic_cache").all() as {
    question: string; answer: string; retrieved_ids: string; vec: Uint8Array; expires_at: number;
  }[]).map((r) => ({
    question: r.question, answer: r.answer, retrievedIds: JSON.parse(r.retrieved_ids) as string[],
    vec: new Float32Array(new Uint8Array(r.vec).buffer), // copy into a fresh, aligned buffer
    expiresAt: r.expires_at,
    version: opts.version,
  }));
  const insert = db.prepare("INSERT INTO semantic_cache (version, question, answer, retrieved_ids, vec, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)");

  const view = (version: string): SemanticCache => ({
    threshold: opts.threshold,
    nearest(queryVec) {
      const t = now();
      let best: SemanticMatch | undefined;
      for (const e of entries) {
        if (e.expiresAt <= t || e.version !== version) continue;
        const score = cosine(e.vec, queryVec);
        if (!best || score > best.score) best = { entry: { question: e.question, answer: e.answer, retrievedIds: e.retrievedIds }, score };
      }
      return best;
    },
    set(vec, entry) {
      const t = now();
      const expiresAt = t + opts.ttlSeconds * 1000;
      entries.push({ ...entry, vec, expiresAt, version });
      insert.run(version, entry.question, entry.answer, JSON.stringify(entry.retrievedIds), new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength), t, expiresAt);
    },
    size: () => entries.filter((e) => e.expiresAt > now() && e.version === version).length,
    close: () => db.close(),
    withVersion: view,
  });
  return view(opts.version);
}

// Embeds the question, serves the nearest cached answer if it is similar enough, otherwise runs `inner`
// and remembers the result. Time spent embedding and scanning is counted on hits AND misses.
export function withSemanticCache(inner: Pipeline, cache: SemanticCache, embed: EmbedFn): Pipeline {
  return async (question, meta) => {
    const t0 = performance.now();
    const [qv] = await embed([question], "query");
    const t1 = performance.now();
    const best = cache.nearest(qv!);
    const t2 = performance.now();
    if (best && best.score >= cache.threshold) {
      return {
        answer: best.entry.answer, retrievedIds: best.entry.retrievedIds, embedMs: t1 - t0, searchMs: t2 - t1,
        ttftMs: t2 - t0, llmMs: 0, totalMs: t2 - t0, usage: { promptTokens: 0, completionTokens: 0 },
        cacheHit: true, cacheLayer: "semantic", cacheScore: best.score, cachedQuestion: best.entry.question,
      };
    }
    const result = await inner(question, meta);
    if (result.refused) return { ...result, embedMs: result.embedMs + (t1 - t0), searchMs: result.searchMs + (t2 - t1), totalMs: performance.now() - t0 }; // never cache a refusal
    cache.set(qv!, { question, answer: result.answer, retrievedIds: result.retrievedIds });
    return { ...result, embedMs: result.embedMs + (t1 - t0), searchMs: result.searchMs + (t2 - t1), totalMs: performance.now() - t0, ...(best && { cacheScore: best.score }) };
  };
}
