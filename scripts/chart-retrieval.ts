// Draws the retrieval-cache experiment as an SVG chart, straight from the logged runs (runs/ret-*.jsonl).
// Same measures as scripts/analyze-retrieval.ts: median time to first token, and the share of requests whose prompt was
// processed in under 1 s. Nothing is typed in: every bar is computed from the rows. Usage: npx tsx scripts/chart-retrieval.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { percentile } from "../src/eval/metrics.js";

type Row = { promptEvalMs: number; ttftMs: number };
const load = (n: string): Row[] => readFileSync(`runs/${n}.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);

const RUNS = [
  { name: "ret-off-a", label: "No retrieval cache, run 1", short: "No cache, run 1", cached: false },
  { name: "ret-off-b", label: "No retrieval cache, run 2", short: "No cache, run 2", cached: false },
  { name: "ret-t85", label: "Retrieval cache, threshold 0.85", short: "Threshold 0.85", cached: true },
  { name: "ret-t75", label: "Retrieval cache, threshold 0.75", short: "Threshold 0.75", cached: true },
  { name: "ret-t65", label: "Retrieval cache, threshold 0.65", short: "Threshold 0.65", cached: true },
  { name: "ret-t65-b", label: "Retrieval cache, 0.65 (repeat run)", short: "0.65, repeat run", cached: true },
];
const data = RUNS.map((r) => {
  const rows = load(r.name);
  if (rows.length !== 100) throw new Error(`${r.name}: expected 100 rows, found ${rows.length}`);
  return { ...r, ttftMs: percentile(rows.map((x) => x.ttftMs), 50), fastShare: rows.filter((x) => x.promptEvalMs < 1000).length / rows.length };
});
console.log("run".padEnd(11), "median ttft ms", "prompt <1 s");
for (const d of data) console.log(d.name.padEnd(11), d.ttftMs.toFixed(0).padStart(14), `${(d.fastShare * 100).toFixed(0)}%`.padStart(11));

// ---- layout (px). Narrow on purpose: the image is shown about 345-700 px wide in an article, so text must start at 14 px.
// Tokens follow the dataviz reference palette (light): accent blue, de-emphasis gray, text inks.
const C = { surface: "#ffffff", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", base: "#c3c2b7", accent: "#2a78d6", control: "#898781" };
const W = 520, ROW = 36, BAR = 20, GROUPGAP = 12, LX = 20, BX = 176, BW = 250;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
// bar with a 4px rounded data end and a square end on the baseline
const bar = (x: number, yy: number, w: number, fill: string) => {
  const r = Math.min(4, w / 2);
  return `<path d="M${x},${yy} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${BAR - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - r} z" fill="${fill}"/>`;
};
const out: string[] = [""]; // out[0] is the <svg> header, filled in once the height is known
const text = (x: number, yy: number, size: number, fill: string, str: string, weight = 400) =>
  out.push(`<text x="${x}" y="${yy}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(str)}</text>`);

// one panel = header + six rows; returns the y where the next block may start
function panel(top: number, title: string, sub: string, value: (d: (typeof data)[number]) => number, max: number, fmt: (v: number) => string): number {
  text(LX, top, 15, C.ink, title, 700);
  text(LX, top + 18, 12, C.muted, sub);
  const y0 = top + 36;
  const rowY = (i: number) => y0 + i * ROW + (i >= 2 ? GROUPGAP : 0);
  const yEnd = rowY(data.length - 1) + ROW - 6;
  out.push(`<line x1="${BX}" y1="${y0 - 6}" x2="${BX}" y2="${yEnd}" stroke="${C.base}" stroke-width="1"/>`);
  data.forEach((d, i) => {
    const yy = rowY(i), mid = yy + BAR / 2 + 5, fill = d.cached ? C.accent : C.control;
    text(LX, mid, 14, C.ink, d.short);
    const w = Math.max(2, (value(d) / max) * BW);
    out.push(bar(BX, yy, w, fill));
    text(BX + w + 8, mid, 14, C.ink, fmt(value(d)), 600);
  });
  return yEnd + 34;
}

let y: number;
text(LX, 34, 20, C.ink, "At threshold 0.65, the first token", 700);
text(LX, 58, 20, C.ink, "arrived about 10x sooner", 700);
const subs = ["Retrieval cache, local model (Qwen3 4B on a MacBook Air M4).", "100 shuffled questions about 20 paragraphs.", "Threshold: how alike two questions must be to share passages.", "The model's own prompt cache was emptied before each run."];
subs.forEach((t, i) => text(LX, 86 + i * 19, 13, C.ink2, t));
out.push(`<rect x="${LX}" y="170" width="12" height="12" rx="2" fill="${C.control}"/>`);
text(LX + 20, 181, 13, C.ink2, "No retrieval cache (control)");
out.push(`<rect x="250" y="170" width="12" height="12" rx="2" fill="${C.accent}"/>`);
text(270, 181, 13, C.ink2, "Retrieval cache");
y = panel(214, "Median time to first token", "seconds, lower is better", (d) => d.ttftMs / 1000, 4, (v) => `${v.toFixed(2)} s`);
y = panel(y + 6, "Prompt processed in under 1 s", "share of requests, higher is better", (d) => d.fastShare, 1, (v) => `${(v * 100).toFixed(0)}%`);
text(LX, y + 4, 11, C.muted, "Source: runs/ret-*.jsonl, drawn by scripts/chart-retrieval.ts. Each run is 100 requests.");
const H = y + 22;
const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" role="img" aria-labelledby="t d">`;
const meta = [
  `<title id="t">Retrieval cache on a local model: time to first token</title>`,
  `<desc id="d">${esc(data.map((d) => `${d.label}: median time to first token ${(d.ttftMs / 1000).toFixed(2)} s, ${(d.fastShare * 100).toFixed(0)}% of requests with prompt time under 1 s`).join("; "))}</desc>`,
  `<rect width="${W}" height="${H}" fill="${C.surface}"/>`,
];
out[0] = svgOpen + "\n" + meta.join("\n");
out.push("</svg>");

mkdirSync("assets", { recursive: true });
writeFileSync("assets/retrieval-ttft.svg", out.join("\n") + "\n");
console.log(`wrote assets/retrieval-ttft.svg (${W}x${H})`);
