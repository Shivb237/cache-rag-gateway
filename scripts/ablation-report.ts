// Builds an HTML report (and a fragment version for publishing as an Artifact) from one or more ablation summaries.
// Usage: npx tsx scripts/ablation-report.ts [--out reports/name] [--title "Report title"] runs/<name>.summary.json [more summaries]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { renderReport, type Summary } from "../src/eval/report.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" }, title: { type: "string" } } });
if (positionals.length === 0) throw new Error("pass at least one runs/<name>.summary.json");
const out = values.out ?? "reports/ablation-report";
const summaries = positionals.map((p) => JSON.parse(readFileSync(p, "utf8")) as Summary);
const hardware = "MacBook Air, Apple M4, 16 GB";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(`${out}.html`, renderReport(summaries, { hardware, title: values.title }));
writeFileSync(`${out}.artifact.html`, renderReport(summaries, { hardware, title: values.title, fragment: true })); // for publishing as an Artifact
console.log(`wrote ${out}.html and ${out}.artifact.html (${summaries.length} section${summaries.length === 1 ? "" : "s"})`);
