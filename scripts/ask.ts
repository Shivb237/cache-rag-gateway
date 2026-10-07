// Asks real subset questions end to end: retrieve top-k, build prompt, call the local model.
// Usage: npx tsx scripts/ask.ts [howMany=3]
import { loadConfig } from "../src/config.js";
import { createEmbedder } from "../src/embed.js";
import { createLlm } from "../src/llm.js";
import { buildMessages } from "../src/rag/generate.js";
import { assertIndexMatches, loadIndex, search } from "../src/rag/index.js";
import { loadSubsetFile, sha256File } from "../src/rag/subset.js";

const howMany = Number(process.argv[2] ?? 3);
const config = loadConfig("configs/base.yaml");
const subset = loadSubsetFile(config.dataset.subsetPath);
const index = loadIndex(config.dataset.indexPath);
assertIndexMatches(index, { model: config.embedding.model, revision: config.embedding.revision, subsetSha256: sha256File(config.dataset.subsetPath) });
const byId = new Map(subset.paragraphs.map((p) => [p.id, p]));
const { embed } = createEmbedder(config.embedding);
const llm = createLlm(config, { logPath: "runs/tmp/ask.jsonl" });

for (const q of subset.questions.slice(0, howMany)) {
  const [qv] = await embed([q.text], "query");
  const hits = search(index, qv!, config.retrieval.topK);
  const rank = hits.findIndex((h) => h.id === q.paragraphId) + 1;
  const r = await llm.complete(buildMessages(q.text, hits.map((h) => byId.get(h.id)!)), { questionId: q.id });
  console.log(`\nQ: ${q.text}`);
  console.log(`gold: ${JSON.stringify([...new Set(q.answers)])}`);
  console.log(`model: ${r.text.trim()}`);
  console.log(`gold paragraph ${q.paragraphId}: ${rank ? `rank ${rank} of top ${config.retrieval.topK}` : "NOT retrieved"}`);
  console.log(`ttft ${Math.round(r.ttftMs)} ms, total ${Math.round(r.totalMs)} ms, prompt ${r.usage.promptTokens} tok, prompt-eval ${Math.round(r.usage.promptEvalMs ?? 0)} ms`);
}
