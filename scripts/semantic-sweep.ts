// Threshold sweep for the semantic cache. Needs only embeddings (no LLM calls), so it is fast and exact.
// Cache = the 200 eval questions. Queries are paraphrases (should hit), hard negatives (other questions
// about the SAME paragraph with different answers; must not hit) and easy negatives (other articles).
// For each threshold: how often does a query hit, and how often is the served answer wrong?
// Usage: npx tsx scripts/semantic-sweep.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { cosine, createEmbedder } from "../src/embed.js";
import { percentile } from "../src/eval/metrics.js";
import { buildSemanticQueries, sameAnswer, type ParaphraseFile } from "../src/eval/semanticSet.js";
import { loadSubsetFile, mulberry32, shuffle } from "../src/rag/subset.js";

const config = loadConfig("configs/base.yaml");
const subset = loadSubsetFile(config.dataset.subsetPath);
const para = JSON.parse(readFileSync("data/eval/paraphrases.json", "utf8")) as ParaphraseFile;
const originals = shuffle(subset.questions, mulberry32(config.seed + 1)).slice(0, config.eval.sampleQuestions);
const queries = buildSemanticQueries(subset, para, originals, config.seed);

const { embed } = createEmbedder(config.embedding);
const embedAll = async (texts: string[]) => {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 64) out.push(...(await embed(texts.slice(i, i + 64), "query")));
  return out;
};
const cacheVecs = await embedAll(originals.map((q) => q.text));
const queryVecs = await embedAll(queries.map((q) => q.text));

// For each query: the nearest cached question and its similarity. A hit serves that question's answer.
const near = queries.map((q, i) => {
  let best = -1, bestScore = -Infinity;
  cacheVecs.forEach((c, j) => { const s = cosine(c, queryVecs[i]!); if (s > bestScore) { bestScore = s; best = j; } });
  const cached = originals[best]!;
  return { half: originals.findIndex((o) => o.id === q.sourceId) % 2, text: q.text, cachedText: cached.text, kind: q.kind, score: bestScore, wrongIfServed: !sameAnswer(cached, q.truth), isSource: q.kind === "paraphrase" && cached.id === q.truth.id };
});

const kinds = ["paraphrase", "hard", "easy"] as const;
const count = Object.fromEntries(kinds.map((k) => [k, near.filter((n) => n.kind === k).length]));
console.log(`cache: ${originals.length} questions | queries: ${count.paraphrase} paraphrases, ${count.hard} hard negatives, ${count.easy} easy negatives`);
console.log("\nnearest-cached-question similarity, by query type (percentiles):");
for (const k of kinds) {
  const s = near.filter((n) => n.kind === k).map((n) => n.score);
  console.log(`  ${k.padEnd(10)} min ${Math.min(...s).toFixed(3)} p5 ${percentile(s, 5).toFixed(3)} p25 ${percentile(s, 25).toFixed(3)} p50 ${percentile(s, 50).toFixed(3)} p75 ${percentile(s, 75).toFixed(3)} p95 ${percentile(s, 95).toFixed(3)} max ${Math.max(...s).toFixed(3)}`);
}

type Row = { threshold: number; paraphraseHit: number; paraphraseHitCorrect: number; hardNegHit: number; hardNegWrongServed: number; easyNegWrongServed: number };
const rows: Row[] = [];
for (let t = 0.6; t < 0.9951; t += 0.01) {
  const tau = +t.toFixed(2);
  const rate = (k: string, f: (n: (typeof near)[number]) => boolean) => near.filter((n) => n.kind === k && n.score >= tau && f(n)).length / count[k as (typeof kinds)[number]]!;
  rows.push({
    threshold: tau,
    paraphraseHit: +rate("paraphrase", () => true).toFixed(4),
    paraphraseHitCorrect: +rate("paraphrase", (n) => !n.wrongIfServed).toFixed(4),
    hardNegHit: +rate("hard", () => true).toFixed(4),
    hardNegWrongServed: +rate("hard", (n) => n.wrongIfServed).toFixed(4),
    easyNegWrongServed: +rate("easy", (n) => n.wrongIfServed).toFixed(4),
  });
}
console.log("\nthreshold | paraphrases hit | of those correct | hard negatives wrongly served | easy negatives wrongly served");
for (const r of rows.filter((x) => Math.round(x.threshold * 100) % 2 === 0 || x.threshold >= 0.9)) {
  console.log(`  ${r.threshold.toFixed(2)}    |     ${(r.paraphraseHit * 100).toFixed(1).padStart(5)}%     |      ${(r.paraphraseHitCorrect * 100).toFixed(1).padStart(5)}%      |           ${(r.hardNegWrongServed * 100).toFixed(1).padStart(5)}%            |         ${(r.easyNegWrongServed * 100).toFixed(1).padStart(5)}%`);
}
mkdirSync("runs", { recursive: true });
writeFileSync("runs/semantic-sweep-queries.jsonl", near.map((n) => JSON.stringify({ kind: n.kind, score: +n.score.toFixed(4), wrongIfServed: n.wrongIfServed, query: n.text, nearestCached: n.cachedText })).join("\n") + "\n");
writeFileSync("runs/semantic-sweep.json", JSON.stringify({ seed: config.seed, embedding: config.embedding, cacheSize: originals.length, queries: count, rows }, null, 2) + "\n");
writeFileSync("runs/semantic-sweep.csv", ["threshold,paraphraseHit,paraphraseHitCorrect,hardNegHit,hardNegWrongServed,easyNegWrongServed", ...rows.map((r) => Object.values(r).join(","))].join("\n") + "\n");

// Held-out check. Pick the threshold on half A of the originals' queries, then report on half B, which
// played no part in the choice. Budget = the most wrong answers we are willing to serve among near-misses.
const budget = Number(process.argv[2] ?? 0.03);
const rateOf = (half: number, tau: number, kind: string, wrongOnly: boolean) => {
  const sel = near.filter((n) => n.half === half && n.kind === kind);
  return sel.filter((n) => n.score >= tau && (!wrongOnly || n.wrongIfServed)).length / sel.length;
};
let chosen = 0.99;
for (let t = 0.6; t < 0.9951; t += 0.01) {
  const tau = +t.toFixed(2);
  if (rateOf(0, tau, "hard", true) <= budget) { chosen = tau; break; } // lowest threshold that stays within budget on half A
}
const sizes = [0, 1].map((h) => ({ paraphrase: near.filter((n) => n.half === h && n.kind === "paraphrase").length, hard: near.filter((n) => n.half === h && n.kind === "hard").length }));
console.log(`\nheld-out check: budget = ${(budget * 100).toFixed(1)}% of near-misses wrongly served; threshold chosen on half A = ${chosen}`);
for (const [name, h] of [["A (used to choose)", 0], ["B (held out)", 1]] as const) {
  console.log(`  half ${name}: paraphrases served ${(rateOf(h, chosen, "paraphrase", false) * 100).toFixed(1)}% (n=${sizes[h]!.paraphrase}) | near-misses wrongly served ${(rateOf(h, chosen, "hard", true) * 100).toFixed(1)}% (n=${sizes[h]!.hard})`);
}
