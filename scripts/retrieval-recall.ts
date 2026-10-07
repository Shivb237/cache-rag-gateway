// Sanity check for retrieval: for every subset question, is its gold paragraph in the top k?
// This is NOT the formal Milestone 2 baseline. It only shows that index + search work.
import { appendFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { createEmbedder } from "../src/embed.js";
import { assertIndexMatches, loadIndex, search } from "../src/rag/index.js";
import { loadSubsetFile, sha256File } from "../src/rag/subset.js";

const config = loadConfig("configs/base.yaml");
const subset = loadSubsetFile(config.dataset.subsetPath);
const index = loadIndex(config.dataset.indexPath);
assertIndexMatches(index, { model: config.embedding.model, revision: config.embedding.revision, subsetSha256: sha256File(config.dataset.subsetPath) });

const { embed } = createEmbedder(config.embedding);
const start = performance.now();
const ks = [1, 5, 10];
const found = new Map(ks.map((k) => [k, 0]));
const BATCH = 64;
for (let i = 0; i < subset.questions.length; i += BATCH) {
  const batch = subset.questions.slice(i, i + BATCH);
  const vecs = await embed(batch.map((q) => q.text), "query");
  batch.forEach((q, j) => {
    const top = search(index, vecs[j]!, Math.max(...ks)).map((h) => h.id);
    for (const k of ks) if (top.slice(0, k).includes(q.paragraphId)) found.set(k, found.get(k)! + 1);
  });
}
const n = subset.questions.length;
const result = Object.fromEntries(ks.map((k) => [`recall@${k}`, +(found.get(k)! / n).toFixed(4)]));
const secs = (performance.now() - start) / 1000;
console.log(`questions: ${n}, pile: ${index.meta.count} paragraphs, time: ${secs.toFixed(1)} s`);
console.log(result);
mkdirSync("runs/tmp", { recursive: true });
appendFileSync("runs/tmp/retrieval-recall.jsonl", JSON.stringify({ t: new Date().toISOString(), kind: "sanity", seed: config.seed, model: config.embedding.model, revision: config.embedding.revision, questions: n, pile: index.meta.count, secs, ...result }) + "\n");
