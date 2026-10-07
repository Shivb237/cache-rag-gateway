// Analysis of the prefix-cache experiment (scripts/run-prefix-experiment.sh). Reads runs/prefix-*.jsonl.
// The first 10 requests of every run are skipped: in the first control run they were contaminated (the
// control's predictable nonce words matched an earlier smoke test whose prompts were still in the cache).
// "Implied reuse" is DERIVED, not measured: 1 - (measured prompt time) / (cold ms-per-token from the clean
// control requests x prompt tokens). Usage: npx tsx scripts/analyze-prefix.ts
import { readFileSync } from "node:fs";
import { mean, percentile } from "../src/eval/metrics.js";

type Row = { questionId: string; answer: string; f1: number; promptTokens: number; promptEvalMs: number; ttftMs: number };
const load = (name: string): Row[] => readFileSync(`runs/${name}.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
const SKIP = 10;
const clean = (name: string) => load(name).slice(SKIP);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const control = [...clean("prefix-off-a"), ...clean("prefix-off-b")];
const coldRate = sum(control.map((r) => r.promptEvalMs)) / sum(control.map((r) => r.promptTokens)); // ms per token
const controlMean = mean(control.map((r) => r.promptEvalMs));
const reuseOf = (rows: Row[]) => 1 - sum(rows.map((r) => r.promptEvalMs)) / (coldRate * sum(rows.map((r) => r.promptTokens)));
console.log(`cold prompt-processing rate from ${control.length} clean control requests: ${coldRate.toFixed(2)} ms/token`);

const arms = ["prefix-off-a", "prefix-off-b", "prefix-rel-shuf", "prefix-sort-shuf", "prefix-rel-grp", "prefix-sort-grp", "prefix-sort-grp-b"];
console.log("\nrun                 mean ms   p50 ms  vs control  implied reuse  reuse>=90%  ttft p50   F1");
for (const name of arms) {
  const rows = clean(name);
  const perRequest = rows.map((r) => 1 - r.promptEvalMs / (coldRate * r.promptTokens));
  console.log(
    `${name.padEnd(18)} ${mean(rows.map((r) => r.promptEvalMs)).toFixed(0).padStart(8)} ${percentile(rows.map((r) => r.promptEvalMs), 50).toFixed(0).padStart(8)} ` +
    `${(((mean(rows.map((r) => r.promptEvalMs)) / controlMean - 1) * 100).toFixed(0) + "%").padStart(10)} ${((reuseOf(rows) * 100).toFixed(0) + "%").padStart(13)} ` +
    `${((perRequest.filter((x) => x >= 0.9).length / rows.length) * 100).toFixed(0).padStart(9)}% ${percentile(rows.map((r) => r.ttftMs), 50).toFixed(0).padStart(9)} ${mean(rows.map((r) => r.f1)).toFixed(3).padStart(6)}`,
  );
}
const baseline = load("baseline");
console.log(`\nbaseline (200 questions, ~190 different paragraphs, default layout): implied reuse ${(reuseOf(baseline) * 100).toFixed(0)}%`);

const answersDiffer = (x: string, y: string) => {
  const A = new Map(load(x).map((r) => [r.questionId, r])), B = new Map(load(y).map((r) => [r.questionId, r]));
  const ids = [...A.keys()];
  const d = ids.map((q) => B.get(q)!.f1 - A.get(q)!.f1);
  return `${ids.filter((q) => A.get(q)!.answer !== B.get(q)!.answer).length} of ${ids.length} answers differ, F1 up for ${d.filter((v) => v > 0).length}, down for ${d.filter((v) => v < 0).length}`;
};
console.log(`\nrelevance vs sorted passages (grouped):   ${answersDiffer("prefix-rel-grp", "prefix-sort-grp")}`);
console.log(`relevance vs sorted passages (shuffled):  ${answersDiffer("prefix-rel-shuf", "prefix-sort-shuf")}`);
console.log(`grouped vs shuffled request order (relevance): ${answersDiffer("prefix-rel-shuf", "prefix-rel-grp")}`);
console.log(`prefix cache off (nonce word) vs plain prompt: ${answersDiffer("prefix-off-b", "prefix-rel-grp")}`);
