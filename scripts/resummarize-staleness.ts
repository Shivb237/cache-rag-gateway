// Rebuilds runs/<name>.summary.json from runs/<name>.jsonl with the current answer classifier (no model calls, no cost).
// Usage: npx tsx scripts/resummarize-staleness.ts staleness-claude
import { readFileSync, writeFileSync } from "node:fs";
import { classifyAnswer, type Edit } from "../src/eval/staleness.js";

const name = process.argv[2] ?? "staleness";
type Row = { arm: string; layer: string; policy: string; answer: string; oldValue: string; newValue: string; cacheHit: boolean; outcome: string };
const rows = readFileSync(`runs/${name}.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
const summary = JSON.parse(readFileSync(`runs/${name}.summary.json`, "utf8"));
for (const r of rows) r.outcome = classifyAnswer(r.answer, { oldValue: r.oldValue, newValue: r.newValue } as Edit);
summary.results = summary.results.map((res: { arm: string }) => {
  const rs = rows.filter((r) => r.arm === res.arm);
  return { ...res, newAnswer: rs.filter((r) => r.outcome === "new").length, staleAnswer: rs.filter((r) => r.outcome === "old").length, other: rs.filter((r) => r.outcome === "other").length };
});
writeFileSync(`runs/${name}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(`runs/${name}.summary.json`, JSON.stringify(summary, null, 2) + "\n");
for (const r of summary.results) console.log(`${r.arm.padEnd(40)} fresh ${String(r.newAnswer).padStart(2)}  stale ${String(r.staleAnswer).padStart(2)}  other ${String(r.other).padStart(2)}`);
