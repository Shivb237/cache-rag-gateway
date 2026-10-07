// Counts how many tokens our real prompts are for the configured Claude model, using the (free) token-counting
// endpoint, and projects the input cost of runs. Run it BEFORE spending: it replaces guesses with measured counts.
// Usage: npx tsx scripts/count-tokens.ts configs/providers/claude_sonnet.yaml [samples=40]
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../src/config.js";
import { createEmbedder } from "../src/embed.js";
import { mean } from "../src/eval/metrics.js";
import { buildMessages } from "../src/rag/generate.js";
import { loadIndex, search } from "../src/rag/index.js";
import { loadSubsetFile, mulberry32, shuffle } from "../src/rag/subset.js";

const config = loadConfig("configs/base.yaml", process.argv[2]);
const samples = Number(process.argv[3] ?? 40);
if (config.llm.provider !== "anthropic") throw new Error("pass a Claude config, e.g. configs/providers/claude_sonnet.yaml");
const subset = loadSubsetFile(config.dataset.subsetPath);
const index = loadIndex(config.dataset.indexPath);
const byId = new Map(subset.paragraphs.map((p) => [p.id, p]));
const { embed } = createEmbedder(config.embedding);
const client = new Anthropic();

const counts: number[] = [];
for (const q of shuffle(subset.questions, mulberry32(config.seed + 1)).slice(0, samples)) {
  const [qv] = await embed([q.text], "query");
  const msgs = buildMessages(q.text, search(index, qv!, config.retrieval.topK).map((h) => byId.get(h.id)!));
  const res = await client.messages.countTokens({
    model: config.llm.model,
    system: msgs[0]!.content,
    messages: [{ role: "user", content: msgs[1]!.content }],
  });
  counts.push(res.input_tokens);
}
const p = config.llm.pricing;
const avg = mean(counts);
console.log(`${config.llm.model}: ${samples} real prompts, input tokens min ${Math.min(...counts)}, mean ${avg.toFixed(0)}, max ${Math.max(...counts)}`);
if (p) {
  console.log(`input cost per call at $${p.inputPerMTok}/MTok: $${((avg * p.inputPerMTok) / 1e6).toFixed(5)}  (answers are about 10 tokens, adding about $${((10 * p.outputPerMTok) / 1e6).toFixed(5)})`);
  console.log(`a 200-request run, no caching: about $${((200 * (avg * p.inputPerMTok + 10 * p.outputPerMTok)) / 1e6).toFixed(3)}`);
}
