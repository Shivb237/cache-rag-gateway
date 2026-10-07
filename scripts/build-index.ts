// Embeds the subset's paragraphs and saves the vector index. Usage: npx tsx scripts/build-index.ts
import { loadConfig } from "../src/config.js";
import { createEmbedder } from "../src/embed.js";
import { buildIndex, saveIndex } from "../src/rag/index.js";
import { loadSubsetFile, sha256File } from "../src/rag/subset.js";

const config = loadConfig("configs/base.yaml");
const subset = loadSubsetFile(config.dataset.subsetPath);
const { embed } = createEmbedder(config.embedding, { logPath: "runs/tmp/embed.jsonl" });

const start = performance.now();
const index = await buildIndex(subset.paragraphs, embed, {
  model: config.embedding.model,
  revision: config.embedding.revision,
  subsetSha256: sha256File(config.dataset.subsetPath),
});
const secs = (performance.now() - start) / 1000;
saveIndex(index, config.dataset.indexPath);
console.log(`indexed ${index.meta.count} paragraphs, dim ${index.meta.dim}, in ${secs.toFixed(1)} s (${((secs / index.meta.count) * 1000).toFixed(0)} ms each, includes model load)`);
console.log(`saved ${config.dataset.indexPath}.json / .f32`);
