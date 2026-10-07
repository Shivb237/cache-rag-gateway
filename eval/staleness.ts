// Staleness: what happens to cached answers when the data changes?
// 1. Edit K paragraphs (a number that answers a question becomes a different number).
// 2. Answer the K questions on the OLD data and put those answers into each cache (as a live cache would hold them).
// 3. Update the data. Ask the same K questions again with each cache either INVALIDATED by the data version or left
//    alone (no invalidation, as if only a TTL protected it), and count answers that still use the old number.
// Usage: npm run staleness -- --name staleness-claude --override configs/providers/claude_sonnet.yaml --k 30
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { answerVersion, cacheKey } from "../src/cache/exact.js";
import { retrievalVersion } from "../src/cache/retrieval.js";
import { loadConfig } from "../src/config.js";
import { createEmbedder } from "../src/embed.js";
import { armConfig, buildArm, type ArmSpec } from "../src/eval/arms.js";
import { applyEdits, chooseEdits, classifyAnswer } from "../src/eval/staleness.js";
import { withRetries } from "../src/eval/retry.js";
import { createLlm } from "../src/llm.js";
import { assertIndexMatches, loadIndex, type VectorIndex } from "../src/rag/index.js";
import { loadSubsetFile, sha256File } from "../src/rag/subset.js";

const { values } = parseArgs({ options: { name: { type: "string" }, override: { type: "string" }, k: { type: "string" } } });
if (!values.name) throw new Error("--name is required");
const K = Number(values.k ?? 30);

const config = loadConfig("configs/base.yaml", values.override);
const v1 = sha256File(config.dataset.subsetPath);
const subset = loadSubsetFile(config.dataset.subsetPath);
const index1 = loadIndex(config.dataset.indexPath);
assertIndexMatches(index1, { model: config.embedding.model, revision: config.embedding.revision, subsetSha256: v1 });
const { embed } = createEmbedder(config.embedding);
const llm = createLlm(config);

const edits = chooseEdits(subset, K, config.seed + 11);
const v2 = createHash("sha256").update(v1 + JSON.stringify(edits)).digest("hex");
console.log(`${edits.length} paragraphs edited. data version ${v1.slice(0, 8)} -> ${v2.slice(0, 8)}`);

// The updated data: new paragraph text, and fresh embeddings for exactly the paragraphs that changed.
const paragraphs1 = new Map(subset.paragraphs.map((p) => [p.id, p]));
const updated = applyEdits(subset.paragraphs, edits);
const paragraphs2 = new Map(updated.map((p) => [p.id, p]));
const changedIds = edits.map((e) => e.paragraphId);
const newVecs = await embed(changedIds.map((id) => paragraphs2.get(id)!.text), "passage");
const index2: VectorIndex = { meta: { ...index1.meta, subsetSha256: v2 }, ids: index1.ids, vectors: index1.vectors.map((v, i) => { const at = changedIds.indexOf(index1.ids[i]!); return at >= 0 ? newVecs[at]! : v; }) };

const deps1 = { embed, llm, index: index1, paragraphs: paragraphs1, subsetSha256: v1 };
const deps2 = { embed, llm, index: index2, paragraphs: paragraphs2, subsetSha256: v2 };
const none: ArmSpec = { name: "none", exact: false, semantic: false, retrieval: false };

// Warm-up (not an edited question), then phase 1: answers on the old data.
await buildArm(config, none, deps1, "warmup").pipeline(subset.questions.find((q) => !edits.some((e) => e.questionId === q.id))!.text);
const old = new Map<string, { answer: string; ids: string[]; vec: Float32Array }>();
const phase1 = buildArm(config, none, deps1, `${values.name}-old`).pipeline;
for (const [i, e] of edits.entries()) {
  const r = await withRetries(phase1)(e.question);
  const [vec] = await embed([e.question], "query");
  old.set(e.questionId, { answer: r.answer, ids: r.retrievedIds, vec: vec! });
  if ((i + 1) % 10 === 0) console.log(`phase 1 (old data): ${i + 1}/${edits.length}`);
}
const oldStillCorrect = edits.filter((e) => classifyAnswer(old.get(e.questionId)!.answer, e) === "old").length;
console.log(`on the old data, ${oldStillCorrect} of ${edits.length} answers contained the old number`);

// Arms: a cache layer x (stale = no invalidation, invalidate = invalidated by data version), plus a fresh control.
const spec = { exact: { ...none, name: "exact", exact: true }, semantic: { ...none, name: "semantic", semantic: true }, retrieval: { ...none, name: "retrieval", retrieval: true, retrievalThreshold: 0.75 } };
const arms: { name: string; layer: keyof typeof spec | "none"; policy: "stale" | "invalidate" | "fresh"; arm: ArmSpec }[] = [
  { name: "fresh (no cache)", layer: "none", policy: "fresh", arm: none },
  ...(["exact", "semantic", "retrieval"] as const).flatMap((layer) => (["stale", "invalidate"] as const).map((policy) => ({ name: `${layer}, ${policy === "stale" ? "no invalidation" : "invalidated by data version"}`, layer, policy, arm: spec[layer] }))),
];

mkdirSync("runs", { recursive: true });
const outPath = `runs/${values.name}.jsonl`;
writeFileSync(outPath, "");
const results = [];
for (const a of arms) {
  // stale arms believe the data is still v1; invalidate arms know it is v2
  const built = buildArm(config, a.arm, deps2, `${values.name}-${a.name}`, a.policy === "stale" ? v1 : v2);
  const cfg = armConfig(config, a.arm);
  for (const e of edits) { // prefill: what the cache held before the update, always tagged with the OLD data version
    const o = old.get(e.questionId)!;
    built.exact?.set(cacheKey(e.question, answerVersion(cfg, v1)), { question: e.question, answer: o.answer, retrievedIds: o.ids });
    built.semantic?.withVersion(answerVersion(cfg, v1)).set(o.vec, { question: e.question, answer: o.answer, retrievedIds: o.ids });
    built.retrieval?.set(o.vec, e.question, o.ids, retrievalVersion(cfg, v1));
  }
  const counts = { new: 0, old: 0, other: 0 };
  let hits = 0, cost = 0;
  for (const e of edits) {
    const r = await withRetries(built.pipeline)(e.question, { arm: a.name });
    const outcome = classifyAnswer(r.answer, e);
    counts[outcome]++;
    if (r.cacheHit) hits++;
    cost += r.costUsd ?? 0;
    appendFileSync(outPath, JSON.stringify({ arm: a.name, layer: a.layer, policy: a.policy, questionId: e.questionId, question: e.question, oldValue: e.oldValue, newValue: e.newValue, answer: r.answer, outcome, cacheHit: r.cacheHit, retrievalHit: r.retrievalHit ?? null }) + "\n");
  }
  results.push({ arm: a.name, layer: a.layer, policy: a.policy, questions: edits.length, newAnswer: counts.new, staleAnswer: counts.old, other: counts.other, cacheHits: hits, modelCalls: edits.length - hits, costUsd: cost });
  console.log(`${a.name.padEnd(38)} fresh ${String(counts.new).padStart(2)}  stale ${String(counts.old).padStart(2)}  other ${String(counts.other).padStart(2)}  (cache hits ${hits}, spent $${llm.spentUsd().toFixed(4)})`);
}
writeFileSync(
  `runs/${values.name}.summary.json`,
  JSON.stringify({ name: values.name, when: new Date().toISOString(), edits: edits.length, dataVersions: { before: v1, after: v2 }, answeredOldNumberBeforeUpdate: oldStillCorrect, setup: { seed: config.seed, llm: config.llm, thresholds: { semantic: config.caches.semantic.threshold, retrieval: 0.75 } }, results }, null, 2) + "\n",
);
