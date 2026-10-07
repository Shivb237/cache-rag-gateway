// Builds the fixed eval subset from the raw SQuAD file and writes it to data/eval/.
// Usage: npx tsx scripts/build-subset.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../src/config.js";
import { loadSquad } from "../src/rag/squad.js";
import { buildSubsetFile } from "../src/rag/subset.js";

const { seed, dataset } = loadConfig("configs/base.yaml");
const subset = buildSubsetFile(dataset.squadPath, seed, dataset.subsetParagraphs);

mkdirSync(dirname(dataset.subsetPath), { recursive: true });
writeFileSync(dataset.subsetPath, JSON.stringify(subset, null, 2) + "\n");

// Coverage report: how many of the 48 articles ended up in the subset?
const all = loadSquad(dataset.squadPath);
const totalArticles = new Set(all.paragraphs.map((p) => p.title)).size;
const perArticle = new Map<string, number>();
for (const p of subset.paragraphs) perArticle.set(p.title, (perArticle.get(p.title) ?? 0) + 1);
const counts = [...perArticle.values()];

console.log(`seed ${seed}, source sha256 ${subset.source.sha256.slice(0, 12)}...`);
console.log(`paragraphs: ${subset.paragraphs.length} of ${all.paragraphs.length}`);
console.log(`questions: ${subset.questions.length} of ${all.questions.length}`);
console.log(`articles represented: ${perArticle.size} of ${totalArticles}`);
console.log(`paragraphs per article in subset: min ${Math.min(...counts)}, max ${Math.max(...counts)}`);
console.log(`wrote ${dataset.subsetPath}`);
