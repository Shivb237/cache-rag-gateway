// Asks ONE question from the eval order through the no-cache pipeline and prints the full error if it fails.
// Usage: npx tsx scripts/debug-question.ts <0-based index> [config overrides, comma separated]
import { loadConfig } from "../src/config.js";
import { createEmbedder } from "../src/embed.js";
import { buildArm } from "../src/eval/arms.js";
import { createLlm } from "../src/llm.js";
import { loadIndex } from "../src/rag/index.js";
import { loadSubsetFile, mulberry32, sha256File, shuffle } from "../src/rag/subset.js";

const config = loadConfig("configs/base.yaml", process.argv[3]);
const subset = loadSubsetFile(config.dataset.subsetPath);
const q = shuffle(subset.questions, mulberry32(config.seed + 1))[Number(process.argv[2] ?? 0)]!;
console.log(`question: ${q.text}`);
const { embed } = createEmbedder(config.embedding);
const deps = { embed, llm: createLlm(config), index: loadIndex(config.dataset.indexPath), paragraphs: new Map(subset.paragraphs.map((p) => [p.id, p])), subsetSha256: sha256File(config.dataset.subsetPath) };
try {
  const r = await buildArm(config, { name: "none", exact: false, semantic: false, retrieval: false }, deps, "debug").pipeline(q.text);
  console.log(`answered: ${r.answer} | cost $${(r.costUsd ?? 0).toFixed(5)}`);
} catch (e) {
  const err = e as { name?: string; status?: number; message?: string };
  console.log(`FAILED: ${err.name} status=${err.status} message=${String(err.message).slice(0, 600)}`);
}
