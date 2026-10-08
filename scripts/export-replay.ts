// Builds site/replay.json for the static demo page from a REAL ablation run (runs/<name>.jsonl + .summary.json).
// It rebuilds the request list with the same seeded builder the runner used, then refuses to write anything unless
// the rebuilt kinds and ids match the logged rows exactly (so a question can never be shown with the wrong answer).
// Usage: npx tsx scripts/export-replay.ts [run-name] [rep]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildMixedWorkload } from "../src/eval/mixedWorkload.js";
import type { ParaphraseFile } from "../src/eval/semanticSet.js";
import { loadSubsetFile, mulberry32, shuffle } from "../src/rag/subset.js";

const name = process.argv[2] ?? "ablation-claude";
const rep = Number(process.argv[3] ?? 0);

interface Row { rep: number; i: number; arm: string; kind: string; answer: string; f1: number; cacheLayer: string | null; refused: boolean; wrongServed: boolean | null; totalMs: number; costUsd: number; qid: string }
const rows = readFileSync(`runs/${name}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row).filter((r) => r.rep === rep);
const summary = JSON.parse(readFileSync(`runs/${name}.summary.json`, "utf8"));

const subset = loadSubsetFile("data/eval/squad-subset.json");
const paraphrases = JSON.parse(readFileSync("data/eval/paraphrases.json", "utf8")) as ParaphraseFile;
const seed: number = summary.setup.seed;
const pool = shuffle(subset.questions, mulberry32(seed + 1));
const items = buildMixedWorkload(subset, paraphrases, pool, { originals: summary.workload.original, seed });

if (items.length !== summary.requests) throw new Error(`rebuilt ${items.length} items, run logged ${summary.requests}`);
const byItem = new Map<number, Row[]>();
for (const r of rows) byItem.set(r.i, [...(byItem.get(r.i) ?? []), r]);
for (let i = 0; i < items.length; i++) {
  const rs = byItem.get(i);
  if (!rs || rs.length !== summary.arms.length) throw new Error(`item ${i}: expected ${summary.arms.length} arm rows, got ${rs?.length ?? 0}`);
  const it = items[i]!; // the length was checked against the log above
  for (const r of rs) {
    if (r.kind !== it.kind || r.qid !== it.q.id) throw new Error(`item ${i} (${r.arm}): logged ${r.kind}/${r.qid} but rebuilt ${it.kind}/${it.q.id}`);
  }
}

const out = {
  source: { run: name, rep, model: summary.setup.llm.model, seed, requests: items.length, workload: summary.workload, arms: summary.arms, thresholds: summary.setup.thresholds, topK: summary.setup.topK, when: summary.when },
  aggregate: summary.aggregate,
  items: items.map((it, i) => ({
    i,
    kind: it.kind,
    question: it.q.text,
    gold: it.q.answers[0] ?? "",
    arms: Object.fromEntries(byItem.get(i)!.map((r) => [r.arm, { layer: r.cacheLayer, ms: Math.round(r.totalMs * 10) / 10, cost: r.costUsd, answer: r.answer, f1: r.f1, wrong: r.wrongServed === true, refused: r.refused }])),
  })),
};
mkdirSync("site", { recursive: true });
writeFileSync("site/replay.json", JSON.stringify(out));
console.log(`site/replay.json: ${items.length} requests x ${summary.arms.length} arms, rep ${rep}, all kinds and ids verified against ${rows.length} logged rows`);
