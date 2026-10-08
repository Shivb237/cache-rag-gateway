// Draws the Claude prompt-caching cost experiment as an SVG, straight from the run summaries
// (runs/prefix-claude-concentrated.summary.json and runs/prefix-claude-diverse.summary.json). Cost is per repetition
// of 100 questions, as the runner logged it; the % is against that workload's own no-caching control.
// Usage: npx tsx scripts/chart-claude-cost.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

type Summary = { aggregate: Record<string, { costUsd: { median: number } }> };
const load = (n: string) => JSON.parse(readFileSync(`runs/${n}.summary.json`, "utf8")) as Summary;
const ARMS = [
  { id: "off", label: "No caching", cached: false },
  { id: "cache-relevance", label: "Caching, relevance order", cached: true },
  { id: "cache-sorted", label: "Caching, sorted passages", cached: true },
  { id: "sorted+retrieval-0.75", label: "Sorted + retrieval cache 0.75", cached: true },
  { id: "sorted+retrieval-0.65", label: "Sorted + retrieval cache 0.65", cached: true },
];
const cost = (s: Summary, id: string) => {
  const a = s.aggregate[id];
  if (!a) throw new Error(`missing arm ${id}`);
  return a.costUsd.median;
};
const panels = [
  { name: "prefix-claude-concentrated", title: "Clustered questions", sub: "100 questions about the same 20 paragraphs" },
  { name: "prefix-claude-diverse", title: "Diverse questions", sub: "100 questions about different paragraphs" },
].map((p) => {
  const s = load(p.name);
  const off = cost(s, "off");
  return { ...p, twin: cost(s, "off-twin"), rows: ARMS.map((a) => ({ ...a, usd: cost(s, a.id), pct: (cost(s, a.id) / off - 1) * 100 })) };
});
for (const p of panels) {
  console.log(p.name, `(control copy $${p.twin.toFixed(3)})`);
  for (const r of p.rows) console.log("  ", r.label.padEnd(32), `$${r.usd.toFixed(3)}`, `${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(1)}%`);
}

// ---- layout. 520 px wide so the 14 px text stays readable when the image is shown 345-700 px wide in an article.
const C = { surface: "#ffffff", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", base: "#c3c2b7", accent: "#2a78d6", control: "#898781" };
const W = 520, ROW = 34, BAR = 20, GROUPGAP = 12, LX = 20, BX = 214, BW = 190, MAX = 0.4;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const bar = (x: number, yy: number, w: number, fill: string) => {
  const r = Math.min(4, w / 2);
  return `<path d="M${x},${yy} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${BAR - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - r} z" fill="${fill}"/>`;
};
const out: string[] = [""]; // out[0] is the <svg> header, filled in once the height is known
const text = (x: number, yy: number, size: number, fill: string, str: string, weight = 400) =>
  out.push(`<text x="${x}" y="${yy}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(str)}</text>`);

text(LX, 34, 20, C.ink, "Prompt caching on Claude:", 700);
text(LX, 58, 20, C.ink, "it only paid when prompts repeated", 700);
["Cost per 100 questions, Claude Sonnet 5.5.", "Retrieval cache threshold: how alike two questions must be to share passages."].forEach((t, i) => text(LX, 86 + i * 19, 13, C.ink2, t));
out.push(`<rect x="${LX}" y="130" width="12" height="12" rx="2" fill="${C.control}"/>`);
text(LX + 20, 141, 13, C.ink2, "No caching (control)");
out.push(`<rect x="230" y="130" width="12" height="12" rx="2" fill="${C.accent}"/>`);
text(250, 141, 13, C.ink2, "Prompt caching setups");

let y = 176;
for (const p of panels) {
  text(LX, y, 15, C.ink, p.title, 700);
  text(LX, y + 18, 12, C.muted, p.sub);
  const y0 = y + 36;
  const rowY = (i: number) => y0 + i * ROW + (i >= 1 ? GROUPGAP : 0);
  const yEnd = rowY(p.rows.length - 1) + ROW - 6;
  out.push(`<line x1="${BX}" y1="${y0 - 6}" x2="${BX}" y2="${yEnd}" stroke="${C.base}" stroke-width="1"/>`);
  p.rows.forEach((r, i) => {
    const yy = rowY(i), mid = yy + BAR / 2 + 5;
    text(LX, mid, 13, C.ink, r.label);
    const w = Math.max(2, (r.usd / MAX) * BW);
    out.push(bar(BX, yy, w, r.cached ? C.accent : C.control));
    text(BX + w + 8, mid, 13, C.ink, `$${r.usd.toFixed(3)}`, 600);
    if (r.cached) text(BX + w + 8 + 52, mid, 13, C.ink2, `${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(0)}%`, 600);
  });
  y = yEnd + 38;
}
text(LX, y, 11, C.muted, "Source: runs/prefix-claude-*.summary.json, drawn by scripts/chart-claude-cost.ts.");
text(LX, y + 15, 11, C.muted, `Control and its identical copy: $${panels[0]!.twin.toFixed(3)} vs $${(panels[0]!.rows[0]!.usd).toFixed(3)} (noise floor).`);
const H = y + 34;
out[0] = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" role="img" aria-labelledby="t d">`,
  `<title id="t">Prompt caching on Claude: cost per 100 questions</title>`,
  `<desc id="d">${esc(panels.map((p) => `${p.title}: ${p.rows.map((r) => `${r.label} $${r.usd.toFixed(3)} (${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(0)}%)`).join(", ")}`).join(". "))}</desc>`,
  `<rect width="${W}" height="${H}" fill="${C.surface}"/>`,
].join("\n");
out.push("</svg>");

mkdirSync("assets", { recursive: true });
writeFileSync("assets/claude-cost.svg", out.join("\n") + "\n");
console.log(`wrote assets/claude-cost.svg (${W}x${H})`);
