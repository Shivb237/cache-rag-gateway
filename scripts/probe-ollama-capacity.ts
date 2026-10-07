// How many different prompts does Ollama keep cached at once? Sends N different real prompts once (cold),
// then asks for them again in the same order and prints how long each second pass took.
// A fast second pass (tens of ms) means that prompt was still cached; about 2-3 s means it was evicted.
// Usage: npx tsx scripts/probe-ollama-capacity.ts [N=24]
import { loadConfig } from "../src/config.js";
import { createEmbedder } from "../src/embed.js";
import { buildMessages } from "../src/rag/generate.js";
import { loadIndex, search } from "../src/rag/index.js";
import { loadSubsetFile, mulberry32, shuffle } from "../src/rag/subset.js";

const N = Number(process.argv[2] ?? 24);
const config = loadConfig("configs/base.yaml");
const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const subset = loadSubsetFile(config.dataset.subsetPath);
const index = loadIndex(config.dataset.indexPath);
const byId = new Map(subset.paragraphs.map((p) => [p.id, p]));
const { embed } = createEmbedder(config.embedding);

const questions = shuffle(subset.questions, mulberry32(config.seed + 9)).slice(0, N);
const prompts = [];
for (const q of questions) {
  const [qv] = await embed([q.text], "query");
  prompts.push(buildMessages(q.text, search(index, qv!, config.retrieval.topK).map((h) => byId.get(h.id)!)));
}
const promptMs = async (messages: unknown) => {
  const res = await fetch(`${host}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: config.llm.model, messages, stream: false, options: { temperature: 0, seed: config.seed, num_predict: 4 } }) });
  return ((await res.json()) as { prompt_eval_duration: number }).prompt_eval_duration / 1e6;
};
console.log(`pass 1: ${N} different prompts, each once (all cold)`);
const first: number[] = [];
for (const p of prompts) first.push(await promptMs(p));
console.log(`  prompt time: median ${[...first].sort((a, b) => a - b)[Math.floor(N / 2)]!.toFixed(0)} ms`);
console.log(`pass 2: the same ${N} prompts again, same order. Prompt time per request (ms):`);
const second: number[] = [];
for (const p of prompts) second.push(await promptMs(p));
console.log("  " + second.map((m, i) => `${i + 1}:${m.toFixed(0)}`).join("  "));
const cached = second.filter((m) => m < 500).length;
console.log(`  served from cache (under 500 ms): ${cached} of ${N}`);
