// Draws the story preview (social card) image as an SVG. Every number on it is computed from the logged runs:
// the laptop figure from runs/ret-*.jsonl (median time to first token) and the Claude figure from
// runs/prefix-claude-*.summary.json (cost with prompt caching against no caching). Usage: npx tsx scripts/story-preview.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { percentile } from "../src/eval/metrics.js";

const rows = (n: string) => readFileSync(`runs/${n}.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { ttftMs: number });
const medianTtft = (n: string) => percentile(rows(n).map((r) => r.ttftMs), 50) / 1000;
const off = ["ret-off-a", "ret-off-b"].map(medianTtft);
const on = ["ret-t65", "ret-t65-b"].map(medianTtft);

type Summary = { aggregate: Record<string, { costUsd: { median: number } }> };
const summary = (n: string) => JSON.parse(readFileSync(`runs/${n}.summary.json`, "utf8")) as Summary;
const rise = (s: Summary, arm: string) => (s.aggregate[arm]!.costUsd.median / s.aggregate["off"]!.costUsd.median - 1) * 100;
const concentrated = summary("prefix-claude-concentrated");
const diverse = summary("prefix-claude-diverse");
const lo = rise(concentrated, "cache-relevance");
const hi = Math.max(...["cache-relevance", "cache-sorted", "sorted+retrieval-0.75", "sorted+retrieval-0.65"].map((a) => rise(diverse, a)));
console.log(`laptop: first token ${off.map((v) => v.toFixed(2)).join("/")} s -> ${on.map((v) => v.toFixed(2)).join("/")} s; Claude: cost +${lo.toFixed(1)}% (clustered) to +${hi.toFixed(1)}% (diverse)`);

const slow = `${Math.round(Math.min(...off))}–${Math.round(Math.max(...off))} s`; // "3–4 s"
const fast = (on.reduce((a, b) => a + b, 0) / on.length).toFixed(1); // "0.3"
const bill = `+${Math.round(lo)}–${Math.round(hi)}%`; // "+18–25%"

// Palette: accent blue and the orange from the dataviz reference (dark steps, so large numerals clear 3:1 on the light card).
const C = { bg: "#f3f4f6", card: "#ffffff", ink: "#0b0b0b", ink2: "#52514e", line: "#d6d8de", blue: "#2a78d6", orange: "#d95926" };
const W = 1200, H = 630;
const t = (x: number, y: number, size: number, fill: string, s: string, weight = 400, anchor = "start") =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${s.replace(/&/g, "&amp;")}</text>`;
const card = (x: number, accent: string, who: string, big: string, line1: string, line2: string) => [
  `<rect x="${x}" y="150" width="500" height="340" rx="20" fill="${C.card}" stroke="${C.line}" stroke-width="2"/>`,
  `<rect x="${x + 36}" y="190" width="14" height="14" rx="3" fill="${accent}"/>`,
  t(x + 62, 204, 26, C.ink2, who, 600),
  t(x + 36, 336, 96, C.ink, big, 800), // sized so the widest value, "+18\u201325%", fits inside the 428 px of card text width
  t(x + 36, 394, 30, C.ink, line1, 600),
  t(x + 36, 436, 26, C.ink2, line2),
].join("\n");

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" role="img" aria-labelledby="t d">`,
  `<title id="t">One cache, two very different results</title>`,
  `<desc id="d">On a MacBook Air with a local model, caching cut the time to first token from ${slow} to ${fast} s. On Claude Sonnet 5.5, the same caching raised cost by ${bill}.</desc>`,
  `<rect width="${W}" height="${H}" fill="${C.bg}"/>`,
  t(70, 98, 46, C.ink, "One cache. Two very different results.", 800),
  card(70, C.blue, "MacBook Air, local Qwen3 4B", `${fast} s`, "time to first token", `down from ${slow}`),
  card(630, C.orange, "Claude Sonnet 5.5", bill, "cost with prompt caching", "until prompts repeat"),
  t(70, 556, 22, C.ink2, "Same RAG pipeline, same dataset (SQuAD). Every number is from logged runs."),
  `</svg>`,
].join("\n");

mkdirSync("assets", { recursive: true });
writeFileSync("assets/story-preview.svg", svg + "\n");
console.log(`wrote assets/story-preview.svg (${W}x${H})`);

// dev.to wants a wide cover (about 1000x420, a 2.4:1 crop), so the same two numbers get a compact layout of their own.
const CW = 1000, CH = 420;
const coverCard = (x: number, accent: string, who: string, big: string, line1: string, line2: string) => [
  `<rect x="${x}" y="96" width="440" height="250" rx="18" fill="${C.card}" stroke="${C.line}" stroke-width="2"/>`,
  `<rect x="${x + 28}" y="124" width="12" height="12" rx="3" fill="${accent}"/>`,
  t(x + 50, 136, 20, C.ink2, who, 600),
  t(x + 28, 228, 76, C.ink, big, 800),
  t(x + 28, 272, 24, C.ink, line1, 600),
  t(x + 28, 306, 20, C.ink2, line2),
].join("\n");
const cover = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CW} ${CH}" width="${CW}" height="${CH}" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" role="img" aria-labelledby="t d">`,
  `<title id="t">One cache, two very different results</title>`,
  `<desc id="d">On a MacBook Air with a local model, caching cut the time to first token from ${slow} to ${fast} s. On Claude Sonnet 5.5, the same caching raised cost by ${bill}.</desc>`,
  `<rect width="${CW}" height="${CH}" fill="${C.bg}"/>`,
  t(40, 64, 34, C.ink, "One cache. Two very different results.", 800),
  coverCard(40, C.blue, "MacBook Air, local Qwen3 4B", `${fast} s`, "time to first token", `down from ${slow}`),
  coverCard(520, C.orange, "Claude Sonnet 5.5", bill, "cost with prompt caching", "until prompts repeat"),
  t(40, 388, 16, C.ink2, "Same RAG pipeline, same dataset (SQuAD). Every number is from logged runs."),
  `</svg>`,
].join("\n");
writeFileSync("assets/devto-cover.svg", cover + "\n");
console.log(`wrote assets/devto-cover.svg (${CW}x${CH})`);
