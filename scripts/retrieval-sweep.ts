// Offline simulation of the retrieval cache (embeddings only, no model calls). It replays the prefix-experiment
// workload in order and, for each similarity threshold, reports: how often a query reuses an earlier query's passage list,
// whether the reused list still contains the question's own paragraph (recall), and how often the prompt's passage
// set equals one from the last 60 requests (what lets the model server's prefix cache reuse the whole passage block).
// Usage: npx tsx scripts/retrieval-sweep.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { createRetrievalCache } from "../src/cache/retrieval.js";
import { loadConfig } from "../src/config.js";
import { createEmbedder } from "../src/embed.js";
import { orderQuestions, pickByParagraph } from "../src/eval/workload.js";
import { loadIndex, search } from "../src/rag/index.js";
import { loadSubsetFile } from "../src/rag/subset.js";

const config = loadConfig("configs/base.yaml");
const subset = loadSubsetFile(config.dataset.subsetPath);
const index = loadIndex(config.dataset.indexPath);
const { embed } = createEmbedder(config.embedding);
const WINDOW = 60; // about how many recent prompts the model server keeps (measured in Milestone 6)
const k = config.retrieval.topK;
const grouped = pickByParagraph(subset.questions, 100, config.seed + 7);

const results: Record<string, unknown>[] = [];
for (const order of ["grouped", "shuffled"] as const) {
  const qs = orderQuestions(grouped, order, config.seed + 8);
  const vecs: Float32Array[] = [];
  for (let i = 0; i < qs.length; i += 64) vecs.push(...(await embed(qs.slice(i, i + 64).map((q) => q.text), "query")));
  console.log(`\n=== ${order} (${qs.length} questions over ${new Set(qs.map((q) => q.paragraphId)).size} paragraphs) ===`);
  console.log("threshold | cache hits | recall@5 of served list | recall@5 without cache | passage set seen in last 60 requests");
  for (const tau of [1.01, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6]) {
    const cache = createRetrievalCache({ ttlSeconds: 3600, threshold: tau });
    const served: string[][] = [];
    let hits = 0, recall = 0, fresh = 0, seen = 0;
    qs.forEach((q, i) => {
      const freshIds = search(index, vecs[i]!, k).map((h) => h.id);
      const near = cache.nearest(vecs[i]!, "v");
      const hit = !!near && near.score >= tau;
      const ids = hit ? near!.ids : freshIds;
      if (!hit) cache.set(vecs[i]!, q.text, ids, "v");
      if (hit) hits++;
      if (ids.includes(q.paragraphId)) recall++;
      if (freshIds.includes(q.paragraphId)) fresh++;
      const key = [...ids].sort().join("|");
      if (served.slice(-WINDOW).some((s) => [...s].sort().join("|") === key)) seen++;
      served.push(ids);
    });
    const n = qs.length;
    const pct = (x: number) => `${((x / n) * 100).toFixed(0)}%`.padStart(4);
    console.log(`  ${tau > 1 ? "no cache" : tau.toFixed(2).padStart(8)} |    ${pct(hits)}    |          ${pct(recall)}           |         ${pct(fresh)}          |               ${pct(seen)}`);
    results.push({ order, threshold: tau > 1 ? null : tau, hits: hits / n, recallServed: recall / n, recallFresh: fresh / n, passageSetSeenRecently: seen / n });
  }
}
mkdirSync("runs", { recursive: true });
writeFileSync("runs/retrieval-sweep.json", JSON.stringify({ seed: config.seed, window: WINDOW, topK: k, questions: grouped.length, results }, null, 2) + "\n");
