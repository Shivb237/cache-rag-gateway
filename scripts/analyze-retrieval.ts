// Analysis of the retrieval-cache experiment (scripts/run-retrieval-experiment.sh). Reads runs/ret-*.jsonl.
// The model was unloaded before each run, so no run saw another run's prompt cache. All 100 requests of each run are used.
// Usage: npx tsx scripts/analyze-retrieval.ts
import { readFileSync } from "node:fs";
import { mean, percentile } from "../src/eval/metrics.js";

type Row = { questionId: string; answer: string; f1: number; em: number; goldRank: number; promptTokens: number; promptEvalMs: number; ttftMs: number; totalMs: number; retrievalHit: boolean | null; retrievedIds: string[] };
const load = (n: string): Row[] => readFileSync(`runs/${n}.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
const arms = ["ret-off-a", "ret-off-b", "ret-t85", "ret-t75", "ret-t65", "ret-t65-b"];
const offMean = mean([...load("ret-off-a"), ...load("ret-off-b")].map((r) => r.promptEvalMs));
console.log("run          retrieval hits   recall@5   mean prompt ms   p50   vs cache-off   ttft p50   F1     EM    distinct passage sets   prompt under 1 s");
for (const n of arms) {
  const rows = load(n);
  const hits = rows.filter((r) => r.retrievalHit === true).length;
  const m = mean(rows.map((r) => r.promptEvalMs));
  const sets = new Set(rows.map((r) => [...r.retrievedIds].sort().join("|"))).size;
  console.log(
    `${n.padEnd(12)} ${(hits + "%").padStart(8)}   ${(rows.filter((r) => r.goldRank >= 1).length + "%").padStart(8)}   ${m.toFixed(0).padStart(11)}   ${percentile(rows.map((r) => r.promptEvalMs), 50).toFixed(0).padStart(5)}   ${(((m / offMean - 1) * 100).toFixed(0) + "%").padStart(10)}   ${percentile(rows.map((r) => r.ttftMs), 50).toFixed(0).padStart(7)}   ${mean(rows.map((r) => r.f1)).toFixed(3)}  ${mean(rows.map((r) => r.em)).toFixed(2)}   ${String(sets).padStart(6)}                ${rows.filter((r) => r.promptEvalMs < 1000).length}%`,
  );
}
const off = new Map(load("ret-off-a").map((r) => [r.questionId, r]));
for (const n of ["ret-t85", "ret-t75", "ret-t65"]) {
  const rows = load(n);
  const changed = rows.filter((r) => r.answer !== off.get(r.questionId)!.answer);
  const missedOnlyHere = rows.filter((r) => r.goldRank === 0 && off.get(r.questionId)!.goldRank >= 1).length;
  console.log(`${n}: ${changed.length} of 100 answers differ from the no-retrieval-cache run; own paragraph lost from the list for ${missedOnlyHere} questions`);
}
