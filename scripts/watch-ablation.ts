// Live, read-only view of an ablation run. Usage: npx tsx scripts/watch-ablation.ts <run-name> [--total N] [--once]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { percentile } from "../src/eval/metrics.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { total: { type: "string" }, once: { type: "boolean" } } });
const name = positionals[0] ?? "ablation";
type Row = { arm: string; rep: number; i: number; cacheHit: boolean; wrongServed: boolean | null; totalMs: number; costUsd: number; f1: number; promptTokens: number; cachedPromptTokens?: number; ttftMs?: number };
const read = (): Row[] => {
  try {
    return readFileSync(`runs/${name}.jsonl`, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Row]; } catch { return []; } });
  } catch { return []; }
};
function render(): boolean {
  const rows = read();
  if (rows.length === 0) { console.log(`waiting for runs/${name}.jsonl ...`); return false; }
  const arms = [...new Set(rows.map((r) => r.arm))];
  const last = rows[rows.length - 1]!;
  const total = Number(values.total ?? 0);
  console.log(`${name}: ${rows.length}${total ? `/${total}` : ""} answers | repetition ${last.rep + 1}, request ${last.i + 1} | spent $${rows.reduce((s, r) => s + r.costUsd, 0).toFixed(4)}`);
  console.log("arm                       answers  from cache  wrong  F1     p50 ms  p95 ms  first tok p50  prompt read from cache  cost $");
  for (const a of arms) {
    const rs = rows.filter((r) => r.arm === a);
    console.log(
      `${a.padEnd(24)} ${String(rs.length).padStart(7)}  ${((rs.filter((r) => r.cacheHit).length / rs.length) * 100).toFixed(0).padStart(8)}%  ${String(rs.filter((r) => r.wrongServed === true).length).padStart(5)}  ${(rs.reduce((s, r) => s + r.f1, 0) / rs.length).toFixed(3)}  ${percentile(rs.map((r) => r.totalMs), 50).toFixed(0).padStart(6)}  ${percentile(rs.map((r) => r.totalMs), 95).toFixed(0).padStart(6)}  ${percentile(rs.map((r) => r.ttftMs ?? r.totalMs), 50).toFixed(0).padStart(13)}  ${(((rs.reduce((s, r) => s + (r.cachedPromptTokens ?? 0), 0)) / Math.max(1, rs.reduce((s, r) => s + r.promptTokens, 0))) * 100).toFixed(0).padStart(21)}%  ${rs.reduce((s, r) => s + r.costUsd, 0).toFixed(3)}`,
    );
  }
  return total > 0 && rows.length >= total;
}
if (values.once) { render(); process.exit(0); }
const tick = () => { process.stdout.write("\x1b[2J\x1b[H"); if (render()) process.exit(0); };
tick();
setInterval(tick, 2000);
