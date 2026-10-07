// Live, read-only view of an eval run in progress. It only reads runs/<name>.jsonl, so it
// cannot disturb the run or its timings.
// Usage: npm run watch -- baseline [--of 200] [--once]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { mean, percentile } from "../src/eval/metrics.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { of: { type: "string" }, once: { type: "boolean" } } });
const name = positionals[0] ?? "baseline";
const total = Number(values.of ?? 200);
const path = `runs/${name}.jsonl`;

type Row = Record<string, any>;
function readRows(): Row[] {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* the runner is mid-write; skip the partial line */ }
  }
  return rows;
}

const f = (x: number, d = 2) => x.toFixed(d);
function render(): boolean {
  const rows = readRows();
  const n = rows.length;
  if (n === 0) { console.log(`waiting for ${path} ...`); return false; }
  const col = (k: string) => rows.map((r) => r[k] as number);
  const avgMs = mean(col("totalMs"));
  const bar = "#".repeat(Math.round((n / total) * 30)).padEnd(30, ".");
  const last = rows[n - 1]!;
  console.log(`${name}: ${n}/${total} [${bar}] ${Math.round((n / total) * 100)}%`);
  console.log(`speed:   avg ${f(avgMs / 1000, 1)} s per question (from the log), about ${f(60000 / avgMs, 1)} questions/min`);
  console.log(`ETA:     about ${f(((total - n) * avgMs) / 60000, 1)} min left (estimate from the average above)`);
  console.log(`so far:  EM ${f(mean(col("em")))}  F1 ${f(mean(col("f1")))}  gold paragraph in top 1: ${f(mean(rows.map((r) => (r.goldRank === 1 ? 1 : 0))))}  in top 5: ${f(mean(rows.map((r) => (r.goldRank >= 1 ? 1 : 0))))}`);
  const wrong = rows.filter((r) => r.wrongServed === true).length;
  const hits = rows.filter((r) => r.cacheHit);
  const misses = rows.filter((r) => !r.cacheHit);
  if (hits.length > 0) {
    const p50 = (rs: Row[]) => percentile(rs.map((r) => r.totalMs as number), 50);
    console.log(`cache:   ${hits.length} hits / ${misses.length} misses (hit rate ${f(hits.length / n)}) | p50 hit ${f(p50(hits), 1)} ms vs p50 miss ${misses.length ? Math.round(p50(misses)) : "-"} ms | wrong answers served: ${wrong} | same answer as baseline: ${rows.filter((r) => r.sameAsEarlier === true).length}/${rows.filter((r) => r.sameAsEarlier !== null).length}`);
  }
  console.log(`latency: p50 ${Math.round(percentile(col("totalMs"), 50))} ms, p95 ${Math.round(percentile(col("totalMs"), 95))} ms | first token p50 ${Math.round(percentile(col("ttftMs"), 50))} ms | prompt ${Math.round(mean(col("promptTokens")))} tokens avg`);
  console.log(`\nlast question: ${last.question}`);
  console.log(`  gold:   ${JSON.stringify(last.gold)}`);
  console.log(`  model:  ${last.answer}   (EM ${last.em}, F1 ${last.f1})`);
  console.log(`  gold paragraph rank: ${last.goldRank || "NOT in top 5"} | ${last.ttftMs} ms to first token, ${last.totalMs} ms total, prompt ${last.promptTokens} tokens`);
  return n >= total;
}

if (values.once) { render(); process.exit(0); }
const tick = () => { process.stdout.write("\x1b[2J\x1b[H"); if (render()) process.exit(0); };
tick();
setInterval(tick, 2000);
