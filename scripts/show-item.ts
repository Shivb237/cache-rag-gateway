// Prints request number <i> of the mixed ablation workload (kind, text, gold). Usage: npx tsx scripts/show-item.ts <i> [originals=60]
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { buildMixedWorkload } from "../src/eval/mixedWorkload.js";
import type { ParaphraseFile } from "../src/eval/semanticSet.js";
import { loadSubsetFile, mulberry32, shuffle } from "../src/rag/subset.js";

const config = loadConfig("configs/base.yaml");
const subset = loadSubsetFile(config.dataset.subsetPath);
const items = buildMixedWorkload(subset, JSON.parse(readFileSync("data/eval/paraphrases.json", "utf8")) as ParaphraseFile, shuffle(subset.questions, mulberry32(config.seed + 1)), { originals: Number(process.argv[3] ?? 60), seed: config.seed });
const it = items[Number(process.argv[2])]!;
console.log(JSON.stringify({ kind: it.kind, id: it.q.id, text: it.q.text, gold: it.q.answers, paragraph: subset.paragraphs.find((p) => p.id === it.q.paragraphId)!.text.slice(0, 300) }, null, 1));
