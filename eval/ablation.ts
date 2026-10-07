// Ablation: every cache arm answers the SAME requests. Within each repetition, for each request the arms run back to
// back in a random order (seeded), so slow drift in the machine or the network hits all arms alike. The whole run is
// repeated, and a twin of the control arm measures the noise floor.
// Usage: npm run ablation -- --name ablation-claude --override configs/providers/claude_sonnet.yaml --reps 3 --originals 80
// Writes runs/<name>.jsonl (one line per request per arm) and runs/<name>.summary.json.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { createEmbedder } from "../src/embed.js";
import { buildArm, type ArmSpec } from "../src/eval/arms.js";
import { summarize, type AblationRow } from "../src/eval/ablationStats.js";
import { bestOverGold, exactMatch, f1 } from "../src/eval/metrics.js";
import { buildMixedWorkload } from "../src/eval/mixedWorkload.js";
import { orderQuestions, pickByParagraph, pickDiverse } from "../src/eval/workload.js";
import { sameAnswer, type ParaphraseFile } from "../src/eval/semanticSet.js";
import { withRetries } from "../src/eval/retry.js";
import { createLlm } from "../src/llm.js";
import { loadIndex, assertIndexMatches } from "../src/rag/index.js";
import { loadSubsetFile, mulberry32, sha256File, shuffle } from "../src/rag/subset.js";

const { values } = parseArgs({ options: { name: { type: "string" }, override: { type: "string" }, matrix: { type: "string" }, reps: { type: "string" }, originals: { type: "string" }, workload: { type: "string" }, n: { type: "string" } } });
if (!values.name) throw new Error("--name is required");
const matrixSchema = z.object({
  control: z.string(),
  arms: z.array(z.object({ name: z.string(), exact: z.boolean(), semantic: z.boolean(), retrieval: z.boolean(), semanticThreshold: z.number().optional(), retrievalThreshold: z.number().optional(), prefix: z.boolean().optional(), order: z.enum(["relevance", "sorted"]).optional() })),
});
const matrix = matrixSchema.parse(parse(readFileSync(values.matrix ?? "configs/ablation/matrix.yaml", "utf8")));
const reps = Number(values.reps ?? 3);
const originalsN = Number(values.originals ?? 80);

const config = loadConfig("configs/base.yaml", values.override);
const subsetSha256 = sha256File(config.dataset.subsetPath);
const subset = loadSubsetFile(config.dataset.subsetPath);
const index = loadIndex(config.dataset.indexPath);
assertIndexMatches(index, { model: config.embedding.model, revision: config.embedding.revision, subsetSha256 });
const paraphrases = JSON.parse(readFileSync("data/eval/paraphrases.json", "utf8")) as ParaphraseFile;
const pool = shuffle(subset.questions, mulberry32(config.seed + 1));
// mixed = the cache ablation stream; concentrated = whole paragraphs' questions (shared context); diverse = one question per paragraph.
const workloadName = values.workload ?? "mixed";
const nQuestions = Number(values.n ?? 100);
const items =
  workloadName === "concentrated" ? orderQuestions(pickByParagraph(subset.questions, nQuestions, config.seed + 7), "shuffled", config.seed + 8).map((q) => ({ kind: "original" as const, q }))
  : workloadName === "diverse" ? pickDiverse(pool, nQuestions).map((q) => ({ kind: "original" as const, q }))
  : buildMixedWorkload(subset, paraphrases, pool, { originals: originalsN, seed: config.seed });
const textToQuestion = new Map(items.map((it) => [it.q.text, it.q]));

const control = matrix.arms.find((a) => a.name === matrix.control);
if (!control) throw new Error(`control arm "${matrix.control}" is not in the matrix`);
const twinName = `${matrix.control}-twin`;
const arms: ArmSpec[] = [...matrix.arms, { ...control, name: twinName }];

const { embed } = createEmbedder(config.embedding);
const llm = createLlm(config);
const paragraphs = new Map(subset.paragraphs.map((p) => [p.id, p]));
const deps = { embed, llm, index, paragraphs, subsetSha256 };

mkdirSync("runs", { recursive: true });
const outPath = `runs/${values.name}.jsonl`;
writeFileSync(outPath, "");
console.log(`${arms.length} arms x ${items.length} requests x ${reps} repetitions = ${arms.length * items.length * reps} answers (cache hits cost no model call)`);

// Load the model before measuring. The question is not in the workload.
const warm = pool.findLast((q) => !items.some((it) => it.q.id === q.id))!;
await buildArm(config, { name: "warmup", exact: false, semantic: false, retrieval: false }, deps, "warmup").pipeline(warm.text);

const rows: AblationRow[] = [];
for (let rep = 0; rep < reps; rep++) {
  const built = arms.map((a) => { const b = buildArm(config, a, deps, `${values.name}-r${rep}-${a.name}`); return { arm: a.name, ...b, pipeline: withRetries(b.pipeline, { onRetry: (n, e) => console.warn(`retry ${n} (${a.name}) after: ${(e as Error).message?.slice(0, 120)}`) }) }; });
  for (const [i, { kind, q }] of items.entries()) {
    for (const b of shuffle(built, mulberry32(config.seed + 1000 * rep + i))) {
      const r = await b.pipeline(q.text, { questionId: q.id, arm: b.arm, rep });
      const served = r.cachedQuestion ? textToQuestion.get(r.cachedQuestion) : undefined;
      const row: AblationRow = {
        rep, i, arm: b.arm, kind, answer: r.answer,
        f1: +bestOverGold(f1, r.answer, q.answers).toFixed(4), em: bestOverGold(exactMatch, r.answer, q.answers),
        cacheHit: r.cacheHit, cacheLayer: r.cacheLayer, retrievalHit: r.retrievalHit ?? null, refused: r.refused ?? false,
        cachedPromptTokens: r.usage.cachedPromptTokens ?? 0, cacheWriteTokens: r.usage.cacheCreationTokens ?? 0, ttftMs: +r.ttftMs.toFixed(2),
        wrongServed: r.cacheLayer === "semantic" && served ? !sameAnswer(served, q) : null,
        totalMs: +r.totalMs.toFixed(2), promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, costUsd: r.costUsd ?? 0,
      };
      rows.push(row);
      appendFileSync(outPath, JSON.stringify({ ...row, qid: q.id }) + "\n");
    }
    if ((i + 1) % 20 === 0 || i + 1 === items.length) console.log(`rep ${rep + 1}/${reps}: ${i + 1}/${items.length} requests, spent so far $${llm.spentUsd().toFixed(4)}`);
  }
}

const s = summarize(rows, matrix.control, twinName);
const kinds = Object.fromEntries([...new Set(items.map((x) => x.kind))].map((k) => [k, items.filter((x) => x.kind === k).length]));
writeFileSync(
  `runs/${values.name}.summary.json`,
  JSON.stringify({
    name: values.name, when: new Date().toISOString(), workloadName, control: matrix.control, twin: twinName, reps, requests: items.length, workload: kinds,
    arms: arms.map((a) => a.name), costUsd: rows.reduce((t, r) => t + r.costUsd, 0),
    setup: { seed: config.seed, llm: config.llm, embedding: config.embedding, topK: config.retrieval.topK, thresholds: { semantic: arms.find((a) => a.semantic)?.semanticThreshold ?? config.caches.semantic.threshold, retrieval: arms.find((a) => a.retrieval)?.retrievalThreshold ?? config.caches.retrieval.threshold }, subsetSha256, node: process.version },
    aggregate: s.aggregate, perRep: s.perRep,
  }, null, 2) + "\n",
);
console.log(`done. summary: runs/${values.name}.summary.json`);
