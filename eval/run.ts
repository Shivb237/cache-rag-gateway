// One command to run the eval:  npm run eval -- --name baseline
// Options: --name <run name> (required)  --override <yaml>  --n <requests>
//          --workload repeat|semantic   (default repeat)
//            repeat:   --repeat-rate <0..1> fraction of requests that repeat an earlier question (default 0)
//            semantic: the 200 originals first (they fill the cache), then 195 paraphrases (should hit),
//                      150 near-miss questions from the same paragraph and 50 from other articles (must not hit)
//            --originals <n>  use only the first n originals (quick smoke tests)
//            prefix:   --n <questions> --order grouped|shuffled  whole paragraphs' questions, grouped or shuffled
//          --compare-to <run name>  compare answers with an earlier run (e.g. the uncached baseline)
// Writes runs/<name>.jsonl (one line per request) and runs/<name>.summary.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { answerVersion, createExactCache, withExactCache } from "../src/cache/exact.js";
import { createRetrievalCache, retrievalVersion } from "../src/cache/retrieval.js";
import { createSemanticCache, withSemanticCache } from "../src/cache/semantic.js";
import { loadConfig } from "../src/config.js";
import { createEmbedder } from "../src/embed.js";
import { bestOverGold, exactMatch, f1, goldRank, mean, percentile } from "../src/eval/metrics.js";
import { buildSemanticQueries, sameAnswer, type ParaphraseFile } from "../src/eval/semanticSet.js";
import { makeWorkload, orderQuestions, pickByParagraph } from "../src/eval/workload.js";
import { withRetries } from "../src/eval/retry.js";
import { createLlm } from "../src/llm.js";
import { createPipeline } from "../src/pipeline.js";
import { assertIndexMatches, loadIndex } from "../src/rag/index.js";
import type { Question } from "../src/rag/squad.js";
import { loadSubsetFile, mulberry32, sha256File, shuffle } from "../src/rag/subset.js";

const { values } = parseArgs({
  options: {
    name: { type: "string" }, override: { type: "string" }, n: { type: "string" }, workload: { type: "string" }, order: { type: "string" },
    "repeat-rate": { type: "string" }, "compare-to": { type: "string" }, originals: { type: "string" },
  },
});
if (!values.name) throw new Error("--name is required, e.g. --name baseline");

const config = loadConfig("configs/base.yaml", values.override);
const subsetSha256 = sha256File(config.dataset.subsetPath);
const subset = loadSubsetFile(config.dataset.subsetPath);
const index = loadIndex(config.dataset.indexPath);
assertIndexMatches(index, { model: config.embedding.model, revision: config.embedding.revision, subsetSha256 });

// Same seed + same subset = same fresh-question order on every run. At repeat rate 0 this is
// exactly the baseline's question list.
const pool = shuffle(subset.questions, mulberry32(config.seed + 1));

type Item = { q: Question; kind: string };
let items: Item[];
let workloadInfo: Record<string, unknown>;
if (values.workload === "semantic") {
  const para = JSON.parse(readFileSync("data/eval/paraphrases.json", "utf8")) as ParaphraseFile;
  const originals = pool.slice(0, values.originals ? Number(values.originals) : config.eval.sampleQuestions);
  const originalIds = new Set(originals.map((q) => q.id));
  const all = buildSemanticQueries(subset, para, originals, config.seed).filter((x) => originalIds.has(x.sourceId));
  const pick = (kind: string, n: number) => shuffle(all.filter((x) => x.kind === kind), mulberry32(config.seed + 5)).slice(0, n);
  const queries = shuffle([...pick("paraphrase", 195), ...pick("hard", 150), ...pick("easy", 50)], mulberry32(config.seed + 6));
  items = [
    ...originals.map((q) => ({ q, kind: "original" })),
    ...queries.map((x) => ({ kind: x.kind, q: { id: `${x.kind}~${x.sourceId}~${x.truth.id}`, text: x.text, answers: x.truth.answers, paragraphId: x.truth.paragraphId } })),
  ];
  workloadInfo = { kind: "semantic", originals: originals.length, paraphrases: pick("paraphrase", 195).length, hard: pick("hard", 150).length, easy: pick("easy", 50).length };
} else if (values.workload === "prefix") {
  // Same questions either way; only the order differs (grouped by paragraph, or shuffled).
  const n = values.n ? Number(values.n) : 100;
  const order = values.order === "shuffled" ? "shuffled" : "grouped";
  items = orderQuestions(pickByParagraph(subset.questions, n, config.seed + 7), order, config.seed + 8).map((q) => ({ q, kind: "original" }));
  workloadInfo = { kind: "prefix", questions: items.length, order, paragraphs: new Set(items.map((it) => it.q.paragraphId)).size };
} else {
  const requests = values.n ? Number(values.n) : config.eval.sampleQuestions;
  const repeatRate = values["repeat-rate"] ? Number(values["repeat-rate"]) : 0;
  const w = makeWorkload(pool, requests, repeatRate, config.seed + 2);
  items = w.items.map((q) => ({ q, kind: "original" }));
  workloadInfo = { kind: "repeat", uniqueQuestions: w.uniqueCount, repeats: w.repeatCount, repeatRateRequested: repeatRate, repeatRateRealized: +(w.repeatCount / requests).toFixed(4) };
}
const textToQuestion = new Map(items.map((it) => [it.q.text, it.q])); // to look up the gold answers of whatever a cache served

// Answers from an earlier run, by question id, so we can see whether a cache changed any answer.
const earlier = new Map<string, string>();
if (values["compare-to"]) {
  for (const line of readFileSync(`runs/${values["compare-to"]}.jsonl`, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line) as { questionId: string; answer: string };
    earlier.set(r.questionId, r.answer);
  }
}

mkdirSync("runs", { recursive: true });
const outPath = `runs/${values.name}.jsonl`;
writeFileSync(outPath, ""); // start fresh so a rerun never mixes with an older one

const { embed } = createEmbedder(config.embedding);
const llm = createLlm(config);
const retrievalCache = config.caches.retrieval.enabled ? createRetrievalCache({ ttlSeconds: config.caches.retrieval.ttlSeconds, threshold: config.caches.retrieval.threshold }) : undefined;
const base = createPipeline({ config, nonceSalt: `${values.name}-${Date.now().toString(36)}`, retrievalCache, retrievalVersion: retrievalVersion(config, subsetSha256), embed, llm, index, paragraphs: new Map(subset.paragraphs.map((p) => [p.id, p])) });

// Each run starts with empty in-memory caches, so runs are independent of each other.
// Order of layers, outermost first: exact -> semantic -> the full pipeline.
const version = answerVersion(config, subsetSha256);
let pipeline = base;
if (config.caches.semantic.enabled) {
  pipeline = withSemanticCache(pipeline, createSemanticCache(":memory:", { ttlSeconds: config.caches.semantic.ttlSeconds, threshold: config.caches.semantic.threshold, version }), embed);
}
if (config.caches.exact.enabled) {
  pipeline = withExactCache(pipeline, createExactCache(":memory:", { ttlSeconds: config.caches.exact.ttlSeconds }), version);
}

pipeline = withRetries(pipeline, { onRetry: (n, e) => console.warn(`retry ${n} after: ${(e as Error).message?.slice(0, 120)}`) });

// Warm-up goes through `base`, not the caches, so it neither pollutes them nor the hit rate.
// It uses a question that is NOT in the workload, otherwise the first real request would be a free prefix-cache hit.
const inWorkload = new Set(items.map((it) => it.q.id));
const warmup = pool.findLast((q) => !inWorkload.has(q.id))!;
for (let i = 0; i < config.eval.warmupCalls; i++) await base(warmup.text);

const rows: Record<string, unknown>[] = [];
const wall = performance.now();
for (const [i, { q, kind }] of items.entries()) {
  const r = await pipeline(q.text, { questionId: q.id });
  const before = earlier.get(q.id);
  const served = r.cachedQuestion ? textToQuestion.get(r.cachedQuestion) : undefined;
  const row = {
    run: values.name, kind, questionId: q.id, question: q.text, gold: [...new Set(q.answers)], answer: r.answer,
    em: bestOverGold(exactMatch, r.answer, q.answers), f1: +bestOverGold(f1, r.answer, q.answers).toFixed(4),
    goldRank: goldRank(r.retrievedIds, q.paragraphId), retrievedIds: r.retrievedIds,
    embedMs: +r.embedMs.toFixed(1), searchMs: +r.searchMs.toFixed(2), ttftMs: +r.ttftMs.toFixed(1), llmMs: +r.llmMs.toFixed(1), totalMs: +r.totalMs.toFixed(1),
    promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, promptEvalMs: r.usage.promptEvalMs ?? null,
    cachedPromptTokens: r.usage.cachedPromptTokens ?? 0, cacheWriteTokens: r.usage.cacheCreationTokens ?? 0, costUsd: +(r.costUsd ?? 0).toFixed(6),
    cacheHit: r.cacheHit, cacheLayer: r.cacheLayer, refused: r.refused ?? false,
    retrievalHit: r.retrievalHit ?? null, retrievalScore: r.retrievalScore === undefined ? null : +r.retrievalScore.toFixed(4),
    cacheScore: r.cacheScore === undefined ? null : +r.cacheScore.toFixed(4), cachedQuestion: r.cachedQuestion ?? null,
    // A semantic hit is "wrong" when the question it was served from has a different gold answer than this one.
    wrongServed: r.cacheLayer === "semantic" && served ? !sameAnswer(served, q) : null,
    sameAsEarlier: before === undefined ? null : before === r.answer, // null = no earlier answer to compare with
  };
  rows.push(row);
  writeFileSync(outPath, rows.map((x) => JSON.stringify(x)).join("\n") + "\n"); // rewritten each time, so a crash keeps progress
  if ((i + 1) % 10 === 0 || i + 1 === items.length) console.log(`${i + 1}/${items.length}`);
}
const wallSecs = (performance.now() - wall) / 1000;

const round = (x: number, d = 4) => (Number.isNaN(x) ? null : +x.toFixed(d));
const col = (rs: Record<string, unknown>[], k: string) => rs.map((r) => r[k] as number);
const hits = rows.filter((r) => r.cacheHit);
const misses = rows.filter((r) => !r.cacheHit);
const rec = (k: number) => mean(rows.map((r) => ((r.goldRank as number) >= 1 && (r.goldRank as number) <= k ? 1 : 0)));
const lat = (rs: Record<string, unknown>[], p: number) => round(percentile(col(rs, "totalMs"), p), 1);
const comparable = rows.filter((r) => r.sameAsEarlier !== null);
const reportedPromptMs = rows.map((r) => r.promptEvalMs).filter((x): x is number => typeof x === "number");
const byKind = Object.fromEntries(
  [...new Set(rows.map((r) => r.kind as string))].map((k) => {
    const rs = rows.filter((r) => r.kind === k);
    const h = rs.filter((r) => r.cacheHit);
    return [k, { requests: rs.length, hits: h.length, hitRate: round(h.length / rs.length), wrongServed: h.filter((r) => r.wrongServed === true).length, wrongServedRate: round(h.filter((r) => r.wrongServed === true).length / rs.length), f1: round(mean(col(rs, "f1"))) }];
  }),
);
const summary = {
  name: values.name,
  when: new Date().toISOString(),
  requests: rows.length,
  workload: workloadInfo,
  warmupCalls: config.eval.warmupCalls,
  wallClockSecs: round(wallSecs, 1),
  metrics: {
    exactMatch: round(mean(col(rows, "em"))), f1: round(mean(col(rows, "f1"))),
    recallAt1: round(rec(1)), recallAt5: round(rec(5)),
    cacheHitRate: round(hits.length / rows.length),
    retrievalCacheHitRate: retrievalCache ? round(rows.filter((r) => r.retrievalHit === true).length / rows.length) : null,
    hitsByLayer: { exact: hits.filter((r) => r.cacheLayer === "exact").length, semantic: hits.filter((r) => r.cacheLayer === "semantic").length },
    llmCalls: misses.length,
    refusals: rows.filter((r) => r.refused === true).length,
    byKind,
    latencyMs: { p50: lat(rows, 50), p95: lat(rows, 95), p99: lat(rows, 99) },
    latencyMsHitsOnly: hits.length ? { p50: lat(hits, 50), p95: lat(hits, 95) } : null,
    latencyMsMissesOnly: misses.length ? { p50: lat(misses, 50), p95: lat(misses, 95) } : null,
    // Only some providers (Ollama) report prompt-processing time; for the others the field is null and is skipped.
    promptEvalMs: reportedPromptMs.length ? { mean: round(mean(reportedPromptMs), 0), p50: round(percentile(reportedPromptMs, 50), 0), p95: round(percentile(reportedPromptMs, 95), 0), under1s: round(reportedPromptMs.filter((x) => x < 1000).length / reportedPromptMs.length) } : null,
    ttftMs: { p50: round(percentile(col(rows, "ttftMs"), 50), 0), p95: round(percentile(col(rows, "ttftMs"), 95), 0) },
    meanPromptTokens: round(mean(col(rows, "promptTokens")), 0), meanCompletionTokens: round(mean(col(rows, "completionTokens")), 1),
    totalTokensProcessed: col(rows, "promptTokens").reduce((a, b) => a + b, 0) + col(rows, "completionTokens").reduce((a, b) => a + b, 0),
    sameAnswerAsEarlierRun: comparable.length ? { compared: comparable.length, rate: round(mean(comparable.map((r) => (r.sameAsEarlier ? 1 : 0)))) } : null,
    costUsd: round(col(rows, "costUsd").reduce((a, b) => a + b, 0), 4), // what the model calls cost (0 for the local model)
    cachedPromptTokens: col(rows, "cachedPromptTokens").reduce((a, b) => a + b, 0), cacheWriteTokens: col(rows, "cacheWriteTokens").reduce((a, b) => a + b, 0),
  },
  setup: {
    seed: config.seed, llm: config.llm, embedding: config.embedding, topK: config.retrieval.topK, caches: config.caches,
    answerVersion: version, subsetSha256, indexMeta: index.meta, node: process.version, comparedTo: values["compare-to"] ?? null,
  },
};
writeFileSync(`runs/${values.name}.summary.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ workload: summary.workload, metrics: summary.metrics }, null, 2));
